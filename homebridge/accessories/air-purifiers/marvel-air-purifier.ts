import { Accessory, AccessoryResponses } from "../accessory";
import {
    API,
    CharacteristicEventTypes,
    CharacteristicGetCallback,
    CharacteristicSetCallback,
    CharacteristicValue,
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

/**
 * Because brightness is discretized into 0~3 levels,
 * we map them to a 0~100 range in HomeKit:
 * 3 brightness steps => 100% in HK
 */
const LIGHTBULB_BRIGHTNESS_UNIT = 100 / 3.0;

/**
 * Because fan speeds are discretized into 6 levels,
 * we map them to a 0~100 range in HomeKit:
 * 6 fan speed steps => 100% in HK
 */
const ROTATION_SPEED_UNIT = 100 / 6.0;

/**
 * MARVEL Air Purifier Accessory
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

        // Endpoints the device uses
        this.endpoints.push(EndpointPath.DEVICES_CONTROL);
        this.endpoints.push(EndpointPath.AIR_DEVICES_HOME);
        this.endpoints.push(EndpointPath.AIR_DEVICES_FILTER_INFO);
    }

    /**
     * Called whenever the parent platform fetches fresh data for each endpoint.
     */
    async refresh(responses: AccessoryResponses): Promise<void> {
        await super.refresh(responses);

        if (!this.isConnected) {
            this.log.debug(
                "Cannot refresh the accessory:",
                this.getPlatformAccessory().displayName
            );
            this.log.debug("The accessory response:", responses);
            return;
        }

        const filterInfo = responses[EndpointPath.AIR_DEVICES_FILTER_INFO];
        const statusInfo = responses[EndpointPath.AIR_DEVICES_HOME];
        const controlInfo = responses[EndpointPath.DEVICES_CONTROL];

        // Update context
        const ctx = this.platformAccessory.context as MarvelAirPurifierInterface;
        ctx.filterInfos = this.getFilterInfos(filterInfo);
        ctx.indoorAirQuality = this.getIndoorAirQuality(statusInfo);
        ctx.controlInfo = this.getControlInfo(controlInfo);

        // Update the HomeKit characteristics
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
            this.setOptionalCharacteristic(
                this.api.hap.Characteristic.Brightness,
                this.lightbulbService,
                this.getLightbulbBrightnessPercentage(ctx)
            );

            // Air Quality
            this.airQualityService?.setCharacteristic(
                this.api.hap.Characteristic.AirQuality,
                this.getCurrentAirQuality(ctx)
            );
            this.setOptionalCharacteristic(
                this.api.hap.Characteristic.PM10Density,
                this.airQualityService,
                ctx.indoorAirQuality.pm10Density
            );
            this.setOptionalCharacteristic(
                this.api.hap.Characteristic.PM2_5Density,
                this.airQualityService,
                ctx.indoorAirQuality.pm25Density
            );
            this.setOptionalCharacteristic(
                this.api.hap.Characteristic.VOCDensity,
                this.airQualityService,
                ctx.indoorAirQuality.vocDensity
            );

            // Humidity
            this.setOptionalCharacteristic(
                this.api.hap.Characteristic.CurrentRelativeHumidity,
                this.humiditySensorService,
                ctx.indoorAirQuality.humidity
            );

            // Temperature
            // NOTE: You had a small mistake referencing `CurrentRelativeHumidity` again; 
            // I'm assuming you meant `CurrentTemperature` here.
            this.setOptionalCharacteristic(
                this.api.hap.Characteristic.CurrentTemperature,
                this.temperatureSensorService,
                ctx.indoorAirQuality.temperature
            );
        });
    }

    /**
     * Build the query payload for each endpoint if needed.
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
     * Called once at initialization (creation or load from cache).
     * We do a one-time fetch, then register all the HAP services.
     */
    async configure() {
        await super.configure();

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

        this.airPurifierService = this.registerAirPurifierService();
        this.airQualityService = this.registerAirQualityService();
        this.humiditySensorService = this.registerHumiditySensorService();
        this.temperatureSensorService = this.registerTemperatureSensorService();
        this.lightbulbService = this.registerLightbulbService();
    }

    /**
     * Safely parse the device's "controlStatus" object into our typed ControlInfo.
     */
    getControlInfo(controlInfo: any): ControlInfo {
        const status = controlInfo?.["controlStatus"];
        if (!status) {
            // Return fallback if missing
            return {
                on: false,
                lightbulbInfo: { on: false, brightness: 0 },
                airQuality: AirQuality.EXCELLENT,
                mode: Mode.AUTO_DRIVING,
                fanSpeed: FanSpeed.SHUTDOWN,
            };
        }

        return {
            on: status[Field.POWER] === "1",
            lightbulbInfo: {
                on: status[Field.LIGHT] === "0",
                brightness: this.parseNullableInt(status[Field.LIGHT_BRIGHTNESS]),
            },
            airQuality: parseInt(status[Field.AIR_QUALITY]) as AirQuality,
            mode: status[Field.MODE] as Mode,
            fanSpeed: status[Field.FAN_SPEED] as FanSpeed,
        };
    }

    /**
     * Safely parse "IAQ" data into our typed IndoorAirQuality,
     * defaulting to 0 if fields are empty strings or missing.
     */
    getIndoorAirQuality(statusInfo: any): IndoorAirQuality {
        const response = statusInfo?.["IAQ"];
        if (!response) {
            return {
                humidity: 0,
                pm25Density: 0,
                pm10Density: 0,
                temperature: 0,
                vocDensity: 0,
            };
        }

        return {
            humidity: this.parseNullableFloat(response["humidity"]),
            pm25Density: this.parseNullableFloat(response["dustpm25"]),
            pm10Density: this.parseNullableFloat(response["dustpm10"]),
            temperature: this.parseNullableFloat(response["temperature"]),
            vocDensity: this.parseNullableFloat(response["vocs"]),
        };
    }

    /**
     * Parse the filter info array (if present).
     */
    getFilterInfos(filterInfo: any): FilterInfo[] {
        const filters = filterInfo?.["filterList"];
        if (!Array.isArray(filters)) {
            return [];
        }
        return filters.map((f: any) => ({
            filterName: f["filterName"],
            filterCode: f["filterCode"],
            filterPercentage: this.parseNullableInt(f["filterPer"]),
        }));
    }

    // ----------------------------------------------------------------------------------
    // REGISTER SERVICES
    // ----------------------------------------------------------------------------------

    registerLightbulbService(): Service {
        const ctx = this.platformAccessory.context as MarvelAirPurifierInterface;
        const service = this.ensureServiceAvailability(this.api.hap.Service.Lightbulb);

        service
            .getCharacteristic(this.api.hap.Characteristic.On)
            .on(CharacteristicEventTypes.GET, this.wrapGet((callback: CharacteristicGetCallback) => {
                callback(undefined, ctx.controlInfo.on && ctx.controlInfo.lightbulbInfo.on);
            }))
            .on(
                CharacteristicEventTypes.SET,
                this.wrapSet(async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                    const enabled = !!value;

                    if (ctx.controlInfo.lightbulbInfo.on === enabled) {
                        callback(undefined);
                        return;
                    }

                    // If purifier is off but user wants light on => turn purifier on
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

        // If brightness is defined, register it
        if (typeof ctx.controlInfo.lightbulbInfo.brightness !== "undefined") {
            service
                .getCharacteristic(this.api.hap.Characteristic.Brightness)
                .setProps({
                    format: this.api.hap.Formats.FLOAT,
                    minValue: 0.0,
                    maxValue: 100.0,
                    minStep: LIGHTBULB_BRIGHTNESS_UNIT,
                })
                .on(CharacteristicEventTypes.GET, this.wrapGet((callback: CharacteristicGetCallback) => {
                    if (!ctx.controlInfo.on) {
                        // purifier off => brightness 0
                        callback(undefined, 0);
                        return;
                    }
                    const brightnessValue =
                        (ctx.controlInfo.lightbulbInfo.brightness ?? 0) * LIGHTBULB_BRIGHTNESS_UNIT;
                    callback(undefined, brightnessValue);
                }))
                .on(
                    CharacteristicEventTypes.SET,
                    this.wrapSet(async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                        const brightness = Math.round((value as number) / LIGHTBULB_BRIGHTNESS_UNIT);

                        if (ctx.controlInfo.lightbulbInfo.brightness === brightness) {
                            callback(undefined);
                            return;
                        }
                        ctx.controlInfo.lightbulbInfo.brightness = brightness;

                        if (brightness === 0) {
                            // brightness 0 => turn light off
                            ctx.controlInfo.lightbulbInfo.on = false;
                            await this.executeSetPayload(ctx.deviceInfo, Field.LIGHT, Light.OFF, this.accessToken);
                            callback(undefined);
                            return;
                        }

                        const commands: PayloadCommand[] = [];
                        // If purifier is off, turn it on first
                        if (!ctx.controlInfo.on) {
                            commands.push({ key: Field.POWER, value: Power.ON });
                        }
                        // Then set brightness
                        commands.push({
                            key: Field.LIGHT_BRIGHTNESS,
                            value: brightness.toFixed(0),
                        });
                        await this.executeSetPayloads(ctx.deviceInfo, commands, this.accessToken);
                        callback(undefined);
                    })
                );
        }
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
                        if (this.isNotNull(ctx.controlInfo.lightbulbInfo.brightness)) {
                            ctx.controlInfo.lightbulbInfo.brightness = 0;
                        }
                        // asynchronously update the lightbulbService
                        setTimeout(() => {
                            this.lightbulbService?.setCharacteristic(
                                this.api.hap.Characteristic.On,
                                false
                            );
                            this.setOptionalCharacteristic(
                                this.api.hap.Characteristic.Brightness,
                                this.lightbulbService,
                                this.getLightbulbBrightnessPercentage(ctx)
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

        // CurrentAirPurifierState
        service
            .getCharacteristic(this.api.hap.Characteristic.CurrentAirPurifierState)
            .on(CharacteristicEventTypes.GET, this.wrapGet((callback: CharacteristicGetCallback) => {
                const ctx = this.platformAccessory.context as MarvelAirPurifierInterface;
                callback(undefined, this.getCurrentAirPurifierState(ctx));
            }));

        // TargetAirPurifierState
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

        // RotationSpeed (0-100)
        service
            .getCharacteristic(this.api.hap.Characteristic.RotationSpeed)
            .setProps({
                format: this.api.hap.Formats.FLOAT,
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

                    // If it's auto-driving and we are in the middle of refreshing => ignore manual speed changes
                    if (ctx.controlInfo.mode === Mode.AUTO_DRIVING && this.characteristicRefreshing) {
                        callback(undefined);
                        return;
                    }
                    if (oldRotationSpeed === newRotationSpeed) {
                        callback(undefined);
                        return;
                    }

                    const commands: PayloadCommand[] = [];
                    // If purifier is off, we need to turn it on
                    if (!ctx.controlInfo.on) {
                        commands.push({ key: Field.POWER, value: Power.ON });
                    } else if (newRotationSpeed === 0) {
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
     * Kick the purifier into AUTO_DRIVING mode
     */
    async driveAutomatically(ctx: MarvelAirPurifierInterface) {
        ctx.controlInfo.mode = Mode.AUTO_DRIVING;
        await this.executeSetPayload(ctx.deviceInfo, Field.MODE, Mode.AUTO_DRIVING, this.accessToken);
    }

    /**
     * Switch from auto-driving to manual speed mode
     */
    async driveManually(ctx: MarvelAirPurifierInterface) {
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
        const ctx = this.platformAccessory.context as MarvelAirPurifierInterface;
        const airQuality = ctx.indoorAirQuality;

        const service = this.ensureServiceAvailability(this.api.hap.Service.AirQualitySensor);

        // AirQuality
        service
            .getCharacteristic(this.api.hap.Characteristic.AirQuality)
            .on(CharacteristicEventTypes.GET, this.wrapGet((callback: CharacteristicGetCallback) => {
                callback(undefined, this.getCurrentAirQuality(ctx));
            }));

        // PM10Density (optional)
        if (this.isNotNull(airQuality.pm10Density)) {
            service
                .getCharacteristic(this.api.hap.Characteristic.PM10Density)
                .on(CharacteristicEventTypes.GET, this.wrapGet((callback: CharacteristicGetCallback) => {
                    callback(undefined, airQuality.pm10Density);
                }));
        }

        // PM2.5 (optional)
        if (this.isNotNull(airQuality.pm25Density)) {
            service
                .getCharacteristic(this.api.hap.Characteristic.PM2_5Density)
                .on(CharacteristicEventTypes.GET, this.wrapGet((callback: CharacteristicGetCallback) => {
                    callback(undefined, airQuality.pm25Density);
                }));
        }

        // VOC (optional)
        if (this.isNotNull(airQuality.vocDensity)) {
            service
                .getCharacteristic(this.api.hap.Characteristic.VOCDensity)
                .on(CharacteristicEventTypes.GET, this.wrapGet((callback: CharacteristicGetCallback) => {
                    callback(undefined, airQuality.vocDensity);
                }));
        }

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

    // ------------------------------------------------------------------------------
    // HELPERS
    // ------------------------------------------------------------------------------

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
     * Compute overall AirQuality by looking at pm10Density and pm25Density (if not null).
     * If the purifier is off, returns UNKNOWN.
     */
    getCurrentAirQuality(ctx: MarvelAirPurifierInterface): CharacteristicValue {
        if (!ctx.controlInfo.on) {
            return this.api.hap.Characteristic.AirQuality.UNKNOWN;
        }

        const pm25 = ctx.indoorAirQuality.pm25Density;
        const pm10 = ctx.indoorAirQuality.pm10Density;
        const levels: number[] = [];

        // Evaluate pm10
        if (this.isNotNull(pm10)) {
            let pm10Level: number;
            if (pm10 < 0) {
                pm10Level = this.api.hap.Characteristic.AirQuality.UNKNOWN;
            } else if (pm10 <= 10) {
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
            levels.push(pm10Level);
        }

        // Evaluate pm25
        if (this.isNotNull(pm25)) {
            let pm25Level: number;
            if (pm25 < 0) {
                pm25Level = this.api.hap.Characteristic.AirQuality.UNKNOWN;
            } else if (pm25 <= 5) {
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
            levels.push(pm25Level);
        }

        if (!levels.length) {
            return this.api.hap.Characteristic.AirQuality.UNKNOWN;
        }
        return Math.max(...levels) as CharacteristicValue;
    }

    /**
     * Convert the device's fan speed (string enum) to a 1~6 scale (then mapped to 0~100 in HK).
     */
    getRotationSpeed(ctx: MarvelAirPurifierInterface) {
        const fanSpeed = ctx.controlInfo.fanSpeed;
        if (fanSpeed === FanSpeed.SHUTDOWN) {
            return 0; // invalid
        }
        const values = Object.values(FanSpeed);
        return values.indexOf(fanSpeed) + 1; // 1~6
    }

    async executeRotationCommand(ctx: MarvelAirPurifierInterface, command: PayloadCommand) {
        if (command.key === Field.MODE) {
            ctx.controlInfo.mode = command.value as Mode;
        } else if (command.key === Field.FAN_SPEED) {
            ctx.controlInfo.fanSpeed = command.value as FanSpeed;
        }
        await this.executeSetPayloads(ctx.deviceInfo, [command], this.accessToken);
    }

    /**
     * Map the numeric rotation speed (1~6) to a device command for mode or fan speed.
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
     * Convert a brightness 0~3 to a 0~100 float. Return undefined if brightness is not set.
     */
    getLightbulbBrightnessPercentage(ctx: MarvelAirPurifierInterface): number | undefined {
        if (typeof ctx.controlInfo.lightbulbInfo.brightness === "undefined") {
            return undefined;
        }
        return ctx.controlInfo.lightbulbInfo.brightness * LIGHTBULB_BRIGHTNESS_UNIT;
    }

    /**
     * Convert our 1~6 fan speed to 0~100 for HomeKit's RotationSpeed.
     */
    getRotationSpeedPercentage(ctx: MarvelAirPurifierInterface): number {
        return this.getRotationSpeed(ctx) * ROTATION_SPEED_UNIT;
    }

    // ----------------------------------------------------------------
    // HELPER METHODS for parsing & optional characteristic setting
    // ----------------------------------------------------------------

    /**
     * Parse a string as an integer, defaulting to 0 if empty/NaN.
     */
    private parseNullableInt(str: any): number {
        if (!str && str !== "0") {
            // covers undefined, null, empty string
            return 0;
        }
        const val = parseInt(str, 10);
        return isNaN(val) ? 0 : val;
    }

    /**
     * Parse a string as a float, defaulting to 0 if empty/NaN.
     */
    private parseNullableFloat(str: any): number {
        if (!str && str !== "0") {
            // covers undefined, null, empty string
            return 0;
        }
        const val = parseFloat(str);
        return isNaN(val) ? 0 : val;
    }

    /**
     * Check if a value is not null/undefined, and not NaN if it's numeric.
     */
    private isNotNull(value: any): boolean {
        if (value === null || value === undefined) {
            return false;
        }
        if (typeof value === "number" && isNaN(value)) {
            return false;
        }
        return true;
    }

    /**
     * If `value` is valid, set it on the given `service` with the given `characteristic`.
     * This prevents setting `NaN` or `undefined` on a characteristic.
     */
    private setOptionalCharacteristic(
        characteristic: WithUUID<{ new(): import("hap-nodejs").Characteristic }>,
        service: Service | undefined,
        value: number | undefined
    ) {
        if (!service) return;
        if (!this.isNotNull(value)) return; // skip if null/undefined/NaN
        service.setCharacteristic(characteristic, value);
    }
}
