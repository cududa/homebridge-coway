import {
    API,
    APIEvent,
    DynamicPlatformPlugin,
    Logging,
    PlatformAccessory,
    PlatformConfig,
} from "homebridge";
import { AccessToken, CowayService } from "./coway";
import { CowayConfig } from "./interfaces/config";
import { Accessory, AccessoryInterface } from "./accessories/accessory";
import { Constants, DeviceType, IoCareEndpoint } from "./enumerations";
import { MarvelAirPurifier } from "./accessories/air-purifiers/marvel-air-purifier";
import { DriverWaterPurifier } from "./accessories/water-purifiers/driver-water-purifier";
import { Device } from "./interfaces/device";
import compareSemanticVersion from "semver-compare";

type AccessoryTypes =
    | typeof DriverWaterPurifier
    | typeof MarvelAirPurifier;

export class CowayPlatform implements DynamicPlatformPlugin {
    private readonly service: CowayService;
    private readonly config?: CowayConfig;
    private readonly accessories: Accessory<AccessoryInterface>[] = [];
    private readonly accessoryRegistry: { [deviceType in DeviceType]: AccessoryTypes } = {
        [DeviceType.DRIVER_WATER_PURIFIER]: DriverWaterPurifier,
        [DeviceType.MARVEL_AIR_PURIFIER]: MarvelAirPurifier,
    };

    private accessToken?: AccessToken = undefined;

    constructor(
        private readonly log: Logging,
        config: PlatformConfig,
        private readonly api: API,
    ) {
        this.service = new CowayService(this.log);
        this.config = this.parseCowayConfig(config);

        if (!this.config) {
            this.log.warn("The coway config is not yet configured.");
            return;
        }

        const hapVersion = api.hap.HAPLibraryVersion();
        if (compareSemanticVersion(hapVersion, "0.10.3") < 0) {
            this.log.error(
                "The HAP-NodeJS prerequisite version is 0.10.3. Currently on " + hapVersion,
            );
            return;
        }

        // Once Homebridge finishes launching, sign in and configure devices.
        this.api.on(APIEvent.DID_FINISH_LAUNCHING, async () => {
            try {
                this.accessToken = await this.service.signIn(this.config);

                const success = await this.configureCowayDevices();
                if (success) {
                    await this.refreshDevicesParallel();
                    this.enqueueDeviceRefreshInterval();
                } else {
                    this.log.warn(
                        "It seems something went wrong with Coway services. Not forcing exit; please check logs for details.",
                    );
                    // Previously we had setTimeout -> process.exit(1) here. It's now removed.
                }
            } catch (err) {
                this.log.error("Unhandled error during DID_FINISH_LAUNCHING:", err);
                // We do NOT call process.exit(1). This prevents forced restarts.
            }
        });
    }

    /**
     * Periodically refresh device states every 5 seconds.
     */
    enqueueDeviceRefreshInterval() {
        setInterval(async () => {
            try {
                await this.refreshDevicesParallel();
            } catch (err) {
                this.log.error("Unhandled error in refreshDevicesParallel:", err);
            }
        }, 120 * 1000);
    }

    /**
     * Refresh all accessories in parallel by calling each accessory's retrieveDeviceState() method.
     */
    async refreshDevicesParallel() {
        try {
            const queues = [];
            for (const accessory of this.accessories) {
                for (const endpoint of accessory.getEndpoints()) {
                    queues.push(accessory.retrieveDeviceState(endpoint));
                }
            }
            const responses = await Promise.all(queues);

            // Each accessory has as many responses as it has endpoints
            for (const accessory of this.accessories) {
                const chunk = responses.splice(0, accessory.getEndpoints().length);
                await accessory.refresh(accessory.zipEndpointResponses(chunk));
            }
        } catch (error) {
            this.log.error("Error in refreshDevicesParallel:", error);
            // Not throwing further since we don't want to kill the entire child bridge
        }
    }

    /**
     * Parse the Coway config from Homebridge's config.json
     */
    parseCowayConfig(config: PlatformConfig): CowayConfig | undefined {
        // If any required fields are missing, return undefined
        for (const key in config) {
            const value = config[key];
            if (value === undefined || !value) {
                return undefined;
            }
        }
        return config as unknown as CowayConfig;
    }

    /**
     * Reconfigure existing accessories from the cache. Homebridge calls this before DID_FINISH_LAUNCHING.
     */
    configureAccessory(platformAccessory: PlatformAccessory) {
        const context = platformAccessory.context as AccessoryInterface;
        const accessoryType = this.accessoryRegistry[context.deviceType as DeviceType];
        if (!accessoryType) {
            this.log.warn("Failed to reconfigure %s", platformAccessory.displayName);
            return;
        }

        const accessory = new accessoryType(
            this.log,
            this.api,
            context.deviceInfo,
            this.service,
            platformAccessory,
        );
        this.accessories.push(accessory);

        // We mark this false and will set to true if/when configure() succeeds
        platformAccessory.context.configured = false;

        this.log.info("Configuring cached accessory: %s", platformAccessory.displayName);
    }

    /**
     * Check which devices are online, then refresh device "netStatus" in the devices array.
     */
    async checkAndRefreshDevicesOnline(devices: Device[]) {
        this.log.debug(
            "checkAndRefreshDevicesOnline => devices:",
            JSON.stringify(devices),
        );

        try {
            const response = await this.service.executeIoCareGetPayload(
                IoCareEndpoint.GET_DEVICE_CONNECTIONS,
                { devIds: devices.map((e) => e.barcode).join(",") },
                this.accessToken,
            );

            this.log.debug(
                "GET_DEVICE_CONNECTIONS response =>",
                JSON.stringify(response),
            );

            if (!response?.data) {
                this.log.warn("GET_DEVICE_CONNECTIONS returned no data or failed");
                return;
            }

            for (const info of response.data) {
                this.log.debug("device connection info =>", JSON.stringify(info));
                devices
                    .filter((e) => e.barcode === info["devId"])
                    .forEach((e) => {
                        e.netStatus = info["netStatus"];
                    });
            }
        } catch (err) {
            this.log.error("Error in checkAndRefreshDevicesOnline:", err);
        }
    }

    /**
     * Fetch the user's Coway devices and create any new accessories, remove old ones.
     */
    async configureCowayDevices(): Promise<boolean> {
        let response;
        try {
            response = await this.service
                .executeIoCareGetPayload(
                    IoCareEndpoint.GET_USER_DEVICES,
                    { pageIndex: "0", pageSize: "100" },
                    this.accessToken,
                )
                .catch((error) => {
                    this.log.debug(
                        "GET_USER_DEVICES error response =>",
                        JSON.stringify(error.response?.data),
                    );
                    return error.response;
                });
        } catch (err) {
            this.log.error("Error fetching GET_USER_DEVICES:", err);
            return false;
        }

        this.log.debug("GET_USER_DEVICES response =>", JSON.stringify(response));

        // Check if deviceInfos is available
        if (!response?.data?.deviceInfos) {
            this.log.error(
                "Coway service is offline or no deviceInfos found in response.",
            );
            return false;
        }

        const deviceInfos: any[] = response.data.deviceInfos;
        this.log.debug("deviceInfos array =>", JSON.stringify(deviceInfos));

        if (!deviceInfos.length) {
            this.log.warn("No Coway devices in your account");
            return false;
        }

        const devices: Device[] = deviceInfos.map((e) => e as Device);
        this.log.debug("Parsed devices =>", JSON.stringify(devices));

        // Check which devices are online
        await this.checkAndRefreshDevicesOnline(devices);

        // Add each device as a Homebridge accessory
        for (const device of devices) {
            this.log.debug("About to add accessory for device =>", JSON.stringify(device));
            try {
                await this.addAccessory(device);
            } catch (err) {
                this.log.error(
                    `Error adding accessory for device ${device.dvcNick}:`,
                    err,
                );
            }
        }

        // Remove any accessories that never got configured
        const accessoriesToRemove = [];
        for (let i = 0; i < this.accessories.length; i++) {
            const accessory = this.accessories[i];
            const platformAccessory = accessory.getPlatformAccessory();
            if (!platformAccessory.context.configured) {
                accessoriesToRemove.push(accessory);
            }
        }

        if (accessoriesToRemove.length) {
            accessoriesToRemove.forEach((accessory) => {
                this.log.info(
                    "Removing accessory:",
                    accessory.getPlatformAccessory().displayName,
                );
                this.accessories.splice(this.accessories.indexOf(accessory), 1);
            });
            this.api.unregisterPlatformAccessories(
                Constants.PLUGIN_NAME,
                Constants.PLATFORM_NAME,
                accessoriesToRemove.map((accessory) => accessory.getPlatformAccessory()),
            );
        }
        return true;
    }

    /**
     * Add or reconfigure an individual device as a Homebridge accessory.
     */
    async addAccessory(deviceInfo: Device) {
        this.log.debug("addAccessory => deviceInfo:", JSON.stringify(deviceInfo));

        const deviceType = deviceInfo.dvcTypeCd as DeviceType;
        const uuid = this.api.hap.uuid.generate(deviceInfo.barcode);

        // Check if accessory already exists
        const existing = this.accessories.find(
            (acc) => acc.getPlatformAccessory().UUID === uuid,
        );
        if (!existing) {
            this.log.info(
                "Adding new accessory: %s (%s)",
                deviceInfo.dvcNick,
                deviceInfo.prodName,
            );

            const platformAccessory = new this.api.platformAccessory(
                deviceInfo.dvcNick,
                uuid,
            );
            const accessoryType = this.accessoryRegistry[deviceType];
            if (!accessoryType) {
                this.log.warn(
                    `No registered accessory type for deviceType: ${deviceType}; skipping.`,
                );
                return;
            }

            const accessory = new accessoryType(
                this.log,
                this.api,
                deviceInfo,
                this.service,
                platformAccessory,
            );

            this.accessories.push(accessory);

            // If configure() throws, we catch it up in configureCowayDevices()
            accessory.configureCredentials(this.config!, this.accessToken!);
            await accessory.configure();

            platformAccessory.context.configured = true;

            this.api.registerPlatformAccessories(Constants.PLUGIN_NAME, Constants.PLATFORM_NAME, [
                platformAccessory,
            ]);
        } else {
            // Reconfigure existing
            this.log.info(
                "Restoring existing accessory: %s (%s)",
                deviceInfo.dvcNick,
                deviceInfo.prodName,
            );

            // If multiple exist with the same UUID, we handle them in a loop
            const duplicates = this.accessories.filter(
                (acc) => acc.getPlatformAccessory().UUID === uuid,
            );
            for (const accessory of duplicates) {
                accessory.configureCredentials(this.config!, this.accessToken!);
                await accessory.configure();

                const platformAccessory = accessory.getPlatformAccessory();
                platformAccessory.context.init = false;
                platformAccessory.context.deviceInfo = deviceInfo;
                platformAccessory.context.deviceType = deviceType;
                platformAccessory.context.configured = true;
            }
        }
    }
}
