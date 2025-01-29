import { Accessory, AccessoryResponses } from "../accessory";
import {
    API,
    CharacteristicEventTypes,
    CharacteristicGetCallback,
    CharacteristicSetCallback,
    CharacteristicValue,
    Formats,
    Logging,
    PlatformAccessory,
    Service,
} from "homebridge";
import { Device } from "../../interfaces/device";
import { CowayService, PayloadCommand } from "../../coway";
import { AirQuality, FanSpeed, Field, Light, Mode, Power } from "./enumerations";
import { DeviceType, EndpointPath } from "../../enumerations";
import {
    ControlInfo,
    FilterInfo,
    IndoorAirQuality,
    MarvelAirPurifierInterface,
} from "./interfaces";
import { IoCarePayloadRequest } from "../../interfaces/requests";

// ------------------------------------------------------
// Constants
// ------------------------------------------------------
/**
 * Because brightness is discretized into 0~3 levels,
 * we map them to a 0~100 range in HomeKit:
 * 3.0 brightness steps => 100% in HK
 */
const LIGHTBULB_BRIGHTNESS_UNIT = 100 / 3.0;
/**
 * Because fan speeds are discretized into 6 levels,
 * we map them to a 0~100 range in HomeKit:
 * 6.0 fan speed steps => 100% in HK
 */
const ROTATION_SPEED_UNIT = 100 / 6.0;

/**
 * MARVEL Air Purifier accessory class. Handles:
 *  - Getting/saving filter info, IAQ data, and control status
 *  - Exposing them as HomeKit characteristics
 *  - Converting numeric data to/from the device's expected values
 */
export class MarvelAirPurifier extends Accessory<MarvelAirPurifierInterface> {
    private airPurifierService?: Service;
    private airQualityService?: Service;
    private humiditySensorService?: Service;
    private temperatureSensorService?: Service;
    private lightbulbService?: Service;

    constructor(
        log: Logging,
        api: API,
        deviceInfo: Device,
        service: CowayService,
        platformAccessory: PlatformAccessory
    ) {
        super(log, api, DeviceType.MARVEL_AIR_PURIFIER, deviceInfo, service, platformAccessory);

        // This device fetches data from three endpoints
        this.endpoints.push(EndpointPath.DEVICES_CONTROL);
        this.endpoints.push(EndpointPath.AIR_DEVICES_HOME);
        this.endpoints.push(EndpointPath.AIR_DEVICES_FILTER_INFO);
    }

    /**
     * Called after retrieving fresh data from each endpoint. We map the raw response
     * to context (filters, IAQ, control), then update HomeKit characteristics accordingly.
     */
    async refresh(responses: AccessoryResponses): Promise<void> {
        await super.refresh(responses);

        if (!this.isConnected) {
            this.log.debug("Cannot refresh the accessory:", this.getPlatformAccessory().displayName);
            this.log.debug("The accessory response:", responses);
            return;
        }

        const filterInfo = responses[EndpointPath.AIR_DEVICES_FILTER_INFO];
        const statusInfo = responses[EndpointPath.AIR_DEVICES_HOME];
        const controlInfo = responses[EndpointPath.DEVICES_CONTROL];

        // Read + update context
        const ctx = this.platformAccessory.context as MarvelAirPurifierInterface;
        ctx.filterInfos = this.getFilterInfos(filterInfo);
        ctx.indoorAirQuality = this.getIndoorAirQuality(statusInfo);
        ctx.controlInfo = this.getControlInfo(controlInfo);

        // Update HomeKit characteristics
        await this.refreshCharacteristics(() => {
            // Air Purifier
            this.airPurifierService?.setCharacteristic(
                this.api.hap.Characteristic.Active,
                ctx.controlInfo.on
            );
            this.airPurifierService?.setCharacteristic(
                this.api.hap.Characteristic.CurrentAirPurifierState,
                this.getCurrentAirPurifierState(ctx)
            );
            this.airPurifierService?.setCharacteristic(
                this.api.hap.Characteristic.TargetAirPurifierState,
                this.getPurifierDrivingStrategy(ctx)
            );
            this.airPurifierService?.setCharacteristic(
                this.api.hap.Characteristic.RotationSpeed,
                this.getRotationSpeedPercentage(ctx)
            );

            // Lightbulb
            this.lightbulbService?.setCharacteristic(
                this.api.hap.Characteristic.On,
                ctx.controlInfo.on && ctx.controlInfo.lightbulbInfo.on
            );
            this.lightbulbService?.setCharacteristic(
                this.api.hap.Characteristic.Brightness,
                this.getLightbulbBrightnessPercentage(ctx)
            );

            // Air Quality
            this.airQualityService?.setCharacteristic(
                this.api.hap.Characteristic.AirQuality,
                this.getCurrentAirQuality(ctx)
            );
            this.airQualityService?.setCharacteristic(
                this.api.hap.Characteristic.PM10Density,
                ctx.indoorAirQuality.pm10Density
            );
            this.airQualityService?.setCharacteristic(
                this.api.hap.Characteristic.PM2_5Density,
                ctx.indoorAirQuality.pm25Density
            );
            this.airQualityService?.setCharacteristic(
                this.api.hap.Characteristic.VOCDensity,
                ctx.indoorAirQuality.vocDensity
            );

            // Humidity
            this.humiditySensorService?.setCharacteristic(
                this.api.hap.Characteristic.CurrentRelativeHumidity,
                ctx.indoorAirQuality.humidity
            );

            // Temperature
            this.temperatureSensorService?.setCharacteristic(
                this.api.hap.Characteristic.CurrentTemperature,
                ctx.indoorAirQuality.temperature
            );
        });
    }

    /**
     * Called by "retrieveDeviceState()" logic in the base class,
     * constructing a query payload for each endpoint if needed.
     */
    createPayload(endpoint: EndpointPath): IoCarePayloadRequest | undefined {
        switch (endpoint) {
            case EndpointPath.AIR_DEVICES_HOME:
                return {
                    admdongCd: this.deviceInfo.admdongCd,
                    barcode: this.deviceInfo.barcode,
                    dvcBrandCd: this.deviceInfo.dvcBrandCd,
                    prodName: this.deviceInfo.prodName,
                    stationCd: this.deviceInfo.stationCd,
                    zipCode: "",
                    resetDttm: this.deviceInfo.resetDttm,
                    deviceType: this.deviceType,
                    mqttDevice: "true",
                    orderNo: this.deviceInfo.ordNo,
                    membershipYn: this.deviceInfo.membershipYn,
                    selfYn: this.deviceInfo.selfManageYn,
                };

            case EndpointPath.AIR_DEVICES_FILTER_INFO:
                return {
                    devId: this.deviceInfo.barcode,
                    orderNo: this.deviceInfo.ordNo,
                    sellTypeCd: this.deviceInfo.sellTypeCd,
                    prodName: this.deviceInfo.prodName,
                    membershipYn: this.deviceInfo.membershipYn,
                    mqttDevice: "true",
                    selfYn: this.deviceInfo.selfManageYn,
                };

            default:
                return super.createPayload(endpoint);
        }
    }

    /**
     * Called once, during plugin initialization, after the accessory is created or loaded from cache.
     * We fetch initial data, set up HAP services, and store the device context.
     */
    async configure() {
        await super.configure();

        // Initial device refresh
        const responses = await this.refreshDevice();
        if (this.isConnected) {
            const filterInfo = responses[EndpointPath.AIR_DEVICES_FILTER_INFO];
            const statusInfo = responses[EndpointPath.AIR_DEVICES_HOME];
            const controlInfo = responses[EndpointPath.DEVICES_CONTROL];

            this.replace({
                deviceType: this.deviceType,
                deviceInfo: this.deviceInfo,
                init: false,
                configured: true,
                filterInfos: this.getFilterInfos(filterInfo),
                indoorAirQuality: this.getIndoorAirQuality(statusInfo),
                controlInfo: this.getControlInfo(controlInfo),
            });
        }

        // Register various HAP Services
        this.airPurifierService = this.registerAirPurifierService();
        this.airQualityService = this.registerAirQualityService();
        this.humiditySensorService = this.registerHumiditySensorService();
        this.temperatureSensorService = this.registerTemperatureSensorService();
        this.lightbulbService = this.registerLightbulbService();
    }

    /**
     * Convert the "controlStatus" object into a strongly typed ControlInfo object,
     * using safe defaults if fields are missing or invalid.
     */
    getControlInfo(controlInfo: any): ControlInfo {
        if (!controlInfo?.controlStatus) {
            // Return safe defaults if the device didn't provide control status
            this.log.debug("No controlStatus in response; using default off/0 states.");
            return {
                on: false,
                lightbulbInfo: { on: false, brightness: 0 },
                airQuality: AirQuality.EXCELLENT,
                mode: Mode.AUTO_DRIVING,
                fanSpeed: FanSpeed.SHUTDOWN,
            };
        }

        const status = controlInfo["controlStatus"];
        // parseInt() on missing fields => NaN => default to 0
        const powerString = status[Field.POWER] ?? "0";
        const lightString = status[Field.LIGHT] ?? "3"; // "3" => OFF
        const brightnessString = status[Field.LIGHT_BRIGHTNESS] ?? "0";
        const airQualityString = status[Field.AIR_QUALITY] ?? "1";
        const modeString = status[Field.MODE] ?? Mode.AUTO_DRIVING;
        const fanSpeedString = status[Field.FAN_SPEED] ?? FanSpeed.SHUTDOWN;

        return {
            on: powerString === "1",
            lightbulbInfo: {
                on: lightString === "0", // 0 => ON, 3 => OFF
                brightness: parseInt(brightnessString) || 0,
            },
            airQuality: parseInt(airQualityString) as AirQuality,
            mode: modeString as Mode,
            fanSpeed: fanSpeedString as FanSpeed,
        };
    }

    /**
     * Convert the "IAQ" object into our typed IndoorAirQuality, defaulting to 0 for empty strings.
     */
    getIndoorAirQuality(statusInfo: any): IndoorAirQuality {
        if (!statusInfo?.IAQ) {
            this.log.debug("No IAQ data found; returning 0 for all air quality fields.");
            return {
                humidity: 0,
                pm25Density: 0,
                pm10Density: 0,
                temperature: 0,
                vocDensity: 0,
            };
        }
        const response = statusInfo["IAQ"];

        // parseFloat("") => NaN => short-circuit to 0
        function safeParseFloat(str?: string): number {
            if (!str) return 0;
            const val = parseFloat(str);
            return isNaN(val) ? 0 : val;
        }

        return {
            humidity: safeParseFloat(response["humidity"]),
            pm25Density: safeParseFloat(response["dustpm25"]),
            pm10Density: safeParseFloat(response["dustpm10"]),
            temperature: safeParseFloat(response["temperature"]),
            vocDensity: safeParseFloat(response["vocs"]),
        };
    }

    /**
     * Parse the "filterList" array into an array of FilterInfo objects.
     * If no data is found, returns an empty array.
     */
    getFilterInfos(filterInfo: any): FilterInfo[] {
        if (!filterInfo?.filterList || !Array.isArray(filterInfo.filterList)) {
            this.log.debug("No filterList found; returning empty array for filterInfos.");
            return [];
        }
        return filterInfo.filterList.map((f: any) => {
            return {
                filterName: f["filterName"] || "Unknown Filter",
                filterCode: f["filterCode"] || "",
                filterPercentage: f["filterPer"] ?? 0,
            };
        });
    }

    // ------------------------------------------------------
    // Registration of Services
    // ------------------------------------------------------

    registerLightbulbService(): Service {
        const service = this.ensureServiceAvailability(this.api.hap.Service.Lightbulb);

        service
            .getCharacteristic(this.api.hap.Characteristic.On)
            .on(CharacteristicEventTypes.GET, this.wrapGet((callback: CharacteristicGetCallback) => {
                const ctx = this.platformAccessory.context as MarvelAirPurifierInterface;
                callback(undefined, ctx.controlInfo.on && ctx.controlInfo.lightbulbInfo.on);
            }))
            .on(
                CharacteristicEventTypes.SET,
                this.wrapSet(async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                    const ctx = this.platformAccessory.context as MarvelAirPurifierInterface;
                    const enabled = !!value;

                    if (ctx.controlInfo.lightbulbInfo.on === enabled) {
                        callback(undefined);
                        return;
                    }

                    // If light is ON but the purifier is OFF, we must power on first
                    if (!ctx.controlInfo.on && enabled) {
                        await this.executeSetPayload(ctx.deviceInfo, Field.POWER, Power.ON, this.accessToken);
                        callback(undefined);
                        return;
                    }

                    ctx.controlInfo.lightbulbInfo.on = enabled;
                    await this.executeSetPayload(
                        ctx.deviceInfo,
                        Field.LIGHT,
                        enabled ? Light.ON : Light.OFF,
                        this.accessToken
                    );
                    callback(undefined);
                })
            );

        service
            .getCharacteristic(this.api.hap.Characteristic.Brightness)
            .setProps({
                format: Formats.FLOAT,
                minValue: 0.0,
                maxValue: 100.0,
                minStep: LIGHTBULB_BRIGHTNESS_UNIT,
            })
            .on(CharacteristicEventTypes.GET, this.wrapGet((callback: CharacteristicGetCallback) => {
                const ctx = this.platformAccessory.context as MarvelAirPurifierInterface;
                if (!ctx.controlInfo.on) {
                    // If purifier is off, brightness is effectively 0
                    callback(undefined, 0);
                    return;
                }
                const brightness = ctx.controlInfo.lightbulbInfo.brightness * LIGHTBULB_BRIGHTNESS_UNIT;
                callback(undefined, brightness);
            }))
            .on(
                CharacteristicEventTypes.SET,
                this.wrapSet(async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                    const ctx = this.platformAccessory.context as MarvelAirPurifierInterface;
                    // Convert the 0~100 HK brightness to 0~3 device brightness
                    const brightness = Math.round((value as number) / LIGHTBULB_BRIGHTNESS_UNIT);

                    if (ctx.controlInfo.lightbulbInfo.brightness === brightness) {
                        callback(undefined);
                        return;
                    }
                    ctx.controlInfo.lightbulbInfo.brightness = brightness;

                    if (brightness === 0) {
                        // If brightness is 0 => turn the purifier light off
                        ctx.controlInfo.lightbulbInfo.on = false;
                        await this.executeSetPayload(ctx.deviceInfo, Field.LIGHT, Light.OFF, this.accessToken);
                        callback(undefined);
                        return;
                    }

                    const commands: PayloadCommand[] = [];
                    // If purifier is off, turn it on
                    if (!ctx.controlInfo.on) {
                        commands.push({ key: Field.POWER, value: Power.ON });
                    }
                    // Then set the brightness
                    commands.push({ key: Field.LIGHT_BRIGHTNESS, value: brightness.toFixed(0) });

                    await this.executeSetPayloads(ctx.deviceInfo, commands, this.accessToken);
                    callback(undefined);
                })
            );

        return service;
    }

    registerAirPurifierService(): Service {
        const service = this.ensureServiceAvailability(this.api.hap.Service.AirPurifier);

        service
            .getCharacteristic(this.api.hap.Characteristic.Active)
            .on(CharacteristicEventTypes.GET, this.wrapGet((callback: CharacteristicGetCallback) => {
                const ctx = this.platformAccessory.context as MarvelAirPurifierInterface;
                const val = ctx.controlInfo.on
                    ? this.api.hap.Characteristic.Active.ACTIVE
                    : this.api.hap.Characteristic.Active.INACTIVE;
                callback(undefined, val);
            }))
            .on(
                CharacteristicEventTypes.SET,
                this.wrapSet(async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                    const ctx = this.platformAccessory.context as MarvelAirPurifierInterface;
                    const enabled = !!value;

                    if (enabled === ctx.controlInfo.on) {
                        callback(undefined);
                        return;
                    }
                    ctx.controlInfo.on = enabled;

                    if (!enabled) {
                        // Turn everything off
                        ctx.controlInfo.lightbulbInfo.on = false;
                        ctx.controlInfo.lightbulbInfo.brightness = 0;

                        // Update the lightbulb service so it's consistent
                        setTimeout(() => {
                            this.lightbulbService?.setCharacteristic(
                                this.api.hap.Characteristic.On,
                                false
                            );
                            this.lightbulbService?.setCharacteristic(
                                this.api.hap.Characteristic.Brightness,
                                0
                            );
                        }, 0);
                    }

                    await this.executeSetPayload(
                        ctx.deviceInfo,
                        Field.POWER,
                        enabled ? Power.ON : Power.OFF,
                        this.accessToken
                    );
                    callback(undefined);
                })
            );

        service
            .getCharacteristic(this.api.hap.Characteristic.CurrentAirPurifierState)
            .on(CharacteristicEventTypes.GET, this.wrapGet((callback: CharacteristicGetCallback) => {
                const ctx = this.platformAccessory.context as MarvelAirPurifierInterface;
                callback(undefined, this.getCurrentAirPurifierState(ctx));
            }));

        service
            .getCharacteristic(this.api.hap.Characteristic.TargetAirPurifierState)
            .on(CharacteristicEventTypes.GET, this.wrapGet((callback: CharacteristicGetCallback) => {
                const ctx = this.platformAccessory.context as MarvelAirPurifierInterface;
                callback(undefined, this.getPurifierDrivingStrategy(ctx));
            }))
            .on(
                CharacteristicEventTypes.SET,
                this.wrapSet(async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                    const ctx = this.platformAccessory.context as MarvelAirPurifierInterface;

                    // If purifier is off, do nothing
                    if (!ctx.controlInfo.on || ctx.controlInfo.fanSpeed === FanSpeed.SHUTDOWN) {
                        callback(undefined);
                        return;
                    }

                    const wasAuto = ctx.controlInfo.mode === Mode.AUTO_DRIVING;
                    const isAuto = value === this.api.hap.Characteristic.TargetAirPurifierState.AUTO;

                    if (wasAuto === isAuto) {
                        callback(undefined);
                        return;
                    }

                    if (isAuto) {
                        await this.driveAutomatically(ctx);
                    } else {
                        const result = await this.driveManually(ctx);
                        if (!result) {
                            callback(new Error("INVALID ROTATION SPEED"));
                            return;
                        }
                    }
                    callback(undefined);
                })
            );

        service
            .getCharacteristic(this.api.hap.Characteristic.RotationSpeed)
            .setProps({
                format: Formats.FLOAT,
                minValue: 0,
                maxValue: 100,
                minStep: ROTATION_SPEED_UNIT,
            })
            .on(CharacteristicEventTypes.GET, this.wrapGet((callback: CharacteristicGetCallback) => {
                const ctx = this.platformAccessory.context as MarvelAirPurifierInterface;
                callback(undefined, this.getRotationSpeedPercentage(ctx));
            }))
            .on(
                CharacteristicEventTypes.SET,
                this.wrapSet(async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                    const ctx = this.platformAccessory.context as MarvelAirPurifierInterface;
                    const oldRotationSpeed = this.getRotationSpeed(ctx);
                    const newRotationSpeed = parseInt(
                        ((value as number) / ROTATION_SPEED_UNIT).toFixed(0)
                    );

                    // If it's currently auto-driving, ignore manual speed changes
                    if (ctx.controlInfo.mode === Mode.AUTO_DRIVING && this.characteristicRefreshing) {
                        callback(undefined);
                        return;
                    }

                    if (oldRotationSpeed === newRotationSpeed) {
                        callback(undefined);
                        return;
                    }

                    const commands: PayloadCommand[] = [];

                    // If purifier is off, power on before changing speed
                    if (!ctx.controlInfo.on) {
                        commands.push({ key: Field.POWER, value: Power.ON });
                    } else if (newRotationSpeed === 0) {
                        // 0 => invalid speed => do nothing
                        callback(undefined);
                        return;
                    }

                    const command = this.createCommandFromRotationSpeed(newRotationSpeed);
                    if (command) {
                        commands.push(command);
                        await this.executeSetPayloads(ctx.deviceInfo, commands, this.accessToken);
                        callback(undefined);
                    } else {
                        this.log.error(
                            "Characteristic: Invalid fan rotation speed (current rotation speed: %d, 0003=%s)",
                            newRotationSpeed,
                            ctx.controlInfo.fanSpeed
                        );
                        callback(new Error("INVALID ROTATION SPEED"));
                    }
                })
            );

        return service;
    }

    /**
     * Switch to auto-driving mode (AUTO_DRIVING).
     */
    async driveAutomatically(ctx: MarvelAirPurifierInterface) {
        ctx.controlInfo.mode = Mode.AUTO_DRIVING;
        await this.executeSetPayload(ctx.deviceInfo, Field.MODE, Mode.AUTO_DRIVING, this.accessToken);
    }

    /**
     * Switch to manual driving, setting the fan speed accordingly.
     */
    async driveManually(ctx: MarvelAirPurifierInterface) {
        // Use the last known rotation speed to pick the correct command
        const rotationSpeed = this.getRotationSpeed(ctx);
        const command = this.createCommandFromRotationSpeed(rotationSpeed);
        if (command) {
            await this.executeRotationCommand(ctx, command);
        } else {
            this.log.error(
                "driveManually(): Invalid fan rotation speed (current rotation speed: %d, 0003=%s)",
                rotationSpeed,
                ctx.controlInfo.fanSpeed
            );
            return false;
        }
        return true;
    }

    registerAirQualityService(): Service {
        const service = this.ensureServiceAvailability(this.api.hap.Service.AirQualitySensor);

        service
            .getCharacteristic(this.api.hap.Characteristic.AirQuality)
            .on(CharacteristicEventTypes.GET, this.wrapGet((callback: CharacteristicGetCallback) => {
                const ctx = this.platformAccessory.context as MarvelAirPurifierInterface;
                callback(undefined, this.getCurrentAirQuality(ctx));
            }));

        service
            .getCharacteristic(this.api.hap.Characteristic.PM10Density)
            .on(CharacteristicEventTypes.GET, this.wrapGet((callback: CharacteristicGetCallback) => {
                const ctx = this.platformAccessory.context as MarvelAirPurifierInterface;
                callback(undefined, ctx.indoorAirQuality.pm10Density);
            }));

        service
            .getCharacteristic(this.api.hap.Characteristic.PM2_5Density)
            .on(CharacteristicEventTypes.GET, this.wrapGet((callback: CharacteristicGetCallback) => {
                const ctx = this.platformAccessory.context as MarvelAirPurifierInterface;
                callback(undefined, ctx.indoorAirQuality.pm25Density);
            }));

        service
            .getCharacteristic(this.api.hap.Characteristic.VOCDensity)
            .on(CharacteristicEventTypes.GET, this.wrapGet((callback: CharacteristicGetCallback) => {
                const ctx = this.platformAccessory.context as MarvelAirPurifierInterface;
                callback(undefined, ctx.indoorAirQuality.vocDensity);
            }));

        return service;
    }

    registerHumiditySensorService(): Service {
        const service = this.ensureServiceAvailability(this.api.hap.Service.HumiditySensor);

        service
            .getCharacteristic(this.api.hap.Characteristic.CurrentRelativeHumidity)
            .on(CharacteristicEventTypes.GET, this.wrapGet((callback: CharacteristicGetCallback) => {
                const ctx = this.platformAccessory.context as MarvelAirPurifierInterface;
                callback(undefined, ctx.indoorAirQuality.humidity);
            }));

        return service;
    }

    registerTemperatureSensorService(): Service {
        const service = this.ensureServiceAvailability(this.api.hap.Service.TemperatureSensor);

        service
            .getCharacteristic(this.api.hap.Characteristic.CurrentTemperature)
            .on(CharacteristicEventTypes.GET, this.wrapGet((callback: CharacteristicGetCallback) => {
                const ctx = this.platformAccessory.context as MarvelAirPurifierInterface;
                callback(undefined, ctx.indoorAirQuality.temperature);
            }));

        return service;
    }

    // ------------------------------------------------------
    // Helper Logic
    // ------------------------------------------------------

    getPurifierDrivingStrategy(ctx: MarvelAirPurifierInterface): CharacteristicValue {
        if (ctx.controlInfo.mode === Mode.AUTO_DRIVING) {
            return this.api.hap.Characteristic.TargetAirPurifierState.AUTO;
        }
        return this.api.hap.Characteristic.TargetAirPurifierState.MANUAL;
    }

    getCurrentAirPurifierState(ctx: MarvelAirPurifierInterface): CharacteristicValue {
        if (!ctx.controlInfo.on) {
            return this.api.hap.Characteristic.CurrentAirPurifierState.INACTIVE;
        }
        if (ctx.controlInfo.mode === Mode.SILENT) {
            return this.api.hap.Characteristic.CurrentAirPurifierState.IDLE;
        }
        return this.api.hap.Characteristic.CurrentAirPurifierState.PURIFYING_AIR;
    }

    /**
     * Return a numeric AirQuality from 1-5, depending on pm10 and pm2.5 levels.
     * If purifier is off, returns UNKNOWN.
     */
    getCurrentAirQuality(ctx: MarvelAirPurifierInterface) {
        if (!ctx.controlInfo.on) {
            return this.api.hap.Characteristic.AirQuality.UNKNOWN;
        }

        const pm25 = ctx.indoorAirQuality.pm25Density;
        const pm10 = ctx.indoorAirQuality.pm10Density;

        // Convert pm10 to an AirQuality index
        let pm10Level = this.api.hap.Characteristic.AirQuality.UNKNOWN;
        if (pm10 >= 0) {
            if (pm10 <= 10) {
                pm10Level = this.api.hap.Characteristic.AirQuality.EXCELLENT;
            } else if (pm10 <= 30) {
                pm10Level = this.api.hap.Characteristic.AirQuality.GOOD;
            } else if (pm10 <= 80) {
                pm10Level = this.api.hap.Characteristic.AirQuality.FAIR;
            } else if (pm10 <= 150) {
                pm10Level = this.api.hap.Characteristic.AirQuality.INFERIOR;
            } else {
                pm10Level = this.api.hap.Characteristic.AirQuality.POOR;
            }
        }

        // Convert pm2.5 to an AirQuality index
        let pm25Level = this.api.hap.Characteristic.AirQuality.UNKNOWN;
        if (pm25 >= 0) {
            if (pm25 <= 5) {
                pm25Level = this.api.hap.Characteristic.AirQuality.EXCELLENT;
            } else if (pm25 <= 15) {
                pm25Level = this.api.hap.Characteristic.AirQuality.GOOD;
            } else if (pm25 <= 35) {
                pm25Level = this.api.hap.Characteristic.AirQuality.FAIR;
            } else if (pm25 <= 75) {
                pm25Level = this.api.hap.Characteristic.AirQuality.INFERIOR;
            } else {
                pm25Level = this.api.hap.Characteristic.AirQuality.POOR;
            }
        }

        // Return the worse of the two
        return Math.max(pm10Level, pm25Level) as CharacteristicValue;
    }

    /**
     * Return an integer 1~6 representing the device's fan speed, or 0 if invalid.
     */
    getRotationSpeed(ctx: MarvelAirPurifierInterface) {
        // The enum order in FanSpeed is used to determine an index
        const values: string[] = Object.values(FanSpeed);
        const fanSpeed = ctx.controlInfo.fanSpeed;
        if (fanSpeed === FanSpeed.SHUTDOWN) {
            return 0; // invalid
        }
        // values.indexOf(FanSpeed.WEAK) => 1, etc.
        return values.indexOf(fanSpeed) + 1; // 1 to 6
    }

    /**
     * Convert the numeric 1~6 speed to an actual device command.
     */
    createCommandFromRotationSpeed(rotationSpeed: number): PayloadCommand | undefined {
        switch (rotationSpeed) {
            case 1:
                return { key: Field.MODE, value: Mode.SILENT };
            case 2:
                return { key: Field.FAN_SPEED, value: FanSpeed.WEAK };
            case 3:
                return { key: Field.FAN_SPEED, value: FanSpeed.MEDIUM };
            case 4:
                return { key: Field.FAN_SPEED, value: FanSpeed.STRONG };
            case 5:
                return { key: Field.MODE, value: Mode.TURBO };
            case 6:
                return { key: Field.MODE, value: Mode.MY_PET };
            default:
                return undefined;
        }
    }

    /**
     * Helper that calls executeSetPayloads() and also updates local context.
     */
    async executeRotationCommand(ctx: MarvelAirPurifierInterface, command: PayloadCommand) {
        if (command.key === Field.MODE) {
            ctx.controlInfo.mode = command.value as Mode;
        } else if (command.key === Field.FAN_SPEED) {
            ctx.controlInfo.fanSpeed = command.value as FanSpeed;
        }
        await this.executeSetPayloads(ctx.deviceInfo, [command], this.accessToken);
    }

    /**
     * Convert the purifier's brightness (0-3) to a 0-100 scale for HomeKit.
     */
    getLightbulbBrightnessPercentage(ctx: MarvelAirPurifierInterface): number {
        return ctx.controlInfo.lightbulbInfo.brightness * LIGHTBULB_BRIGHTNESS_UNIT;
    }

    /**
     * Convert the purifier's fan speed (0-6) to a 0-100 scale for HomeKit's rotation speed.
     */
    getRotationSpeedPercentage(ctx: MarvelAirPurifierInterface): number {
        return this.getRotationSpeed(ctx) * ROTATION_SPEED_UNIT;
    }
}
