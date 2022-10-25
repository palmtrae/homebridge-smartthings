import { PlatformAccessory, CharacteristicValue, PrimitiveTypes } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';

export class LightService extends BaseService {

  // Because of a bug in SmartThings API, we cannot use setHue/setSaturation separately,
  // we must instead use `setColor`, with both hue and saturation defined at the same time
  // (because of another bug with setColor: hue specifically).
  //
  // Specific API error for setHue and setSaturation
  // http status code: 424 (undocumented)
  // "error":{"code":"connector failed","message":"java.lang.Integer cannot be cast to java.util.Map","details":[]}}
  private deferredHue: CharacteristicValue | undefined;
  private deferredSaturation: CharacteristicValue | undefined;

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    super(platform, accessory, multiServiceAccessory, name, deviceStatus);

    this.setServiceType(platform.Service.Lightbulb);

    // Set the event handlers
    this.log.debug(`Adding LightService to ${this.name}`);
    this.service.getCharacteristic(platform.Characteristic.On)
      .onGet(this.getSwitchState.bind(this))
      .onSet(this.setSwitchState.bind(this));

    if (accessory.context.device.components[0].capabilities.find(c => c.id === 'switchLevel')) {
      this.log.debug(`${this.name} supports switchLevel`);
      this.service.getCharacteristic(platform.Characteristic.Brightness)
        .onSet(this.setLevel.bind(this))
        .onGet(this.getLevel.bind(this));
    }

    // If this bulb supports colorTemperature, then add those handlers
    if (accessory.context.device.components[0].capabilities.find(c => c.id === 'colorTemperature')) {
      this.log.debug(`${this.name} supports colorTemperature`);
      const colorTempCharacteristic = this.service.getCharacteristic(platform.Characteristic.ColorTemperature);
      colorTempCharacteristic.props.minValue = 110; // Maximum (coldest value) defined in SmartThings, its about 9000K
      colorTempCharacteristic
        .onSet(this.setColorTemp.bind(this))
        .onGet(this.getColorTemp.bind(this));
    }

    // If we support color control...
    if (accessory.context.device.components[0].capabilities.find(c => c.id === 'colorControl')) {
      this.log.debug(`${this.name} supports colorControl`);
      this.service.getCharacteristic(platform.Characteristic.Hue)
        .onSet(this.setHue.bind(this))
        .onGet(this.getHue.bind(this));
      this.service.getCharacteristic(platform.Characteristic.Saturation)
        .onSet(this.setSaturation.bind(this))
        .onGet(this.getSaturation.bind(this));
    }

    let pollSwitchesAndLightsSeconds = 10; // default to 10 seconds
    if (this.platform.config.PollSwitchesAndLightsSeconds !== undefined) {
      pollSwitchesAndLightsSeconds = this.platform.config.PollSwitchesAndLightsSeconds;
    }

    if (pollSwitchesAndLightsSeconds > 0) {
      multiServiceAccessory.startPollingState(pollSwitchesAndLightsSeconds, this.getSwitchState.bind(this), this.service,
        platform.Characteristic.On);
    }
  }


  async setSwitchState(value: CharacteristicValue) {
    this.log.debug('Received setSwitchState(' + value + ') event for ' + this.name);

    if (!this.multiServiceAccessory.isOnline) {
      this.log.error(this.name + ' is offline');
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    this.multiServiceAccessory.sendCommand('switch', value ? 'on' : 'off').then((success) => {
      if (success) {
        this.log.debug('onSet(' + value + ') SUCCESSFUL for ' + this.name);
      } else {
        this.log.error(`Command failed for ${this.name}`);
      }
    });
  }


  async getSwitchState(): Promise<CharacteristicValue> {
    // if you need to return an error to show the device as "Not Responding" in the Home app:
    // throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    this.log.debug('Received getSwitchState() event for ' + this.name);

    return new Promise((resolve, reject) => {
      this.getStatus().then(success => {
        if (success) {
          const switchState = this.deviceStatus.status.switch.switch.value;
          this.log.debug(`SwitchState value from ${this.name}: ${switchState}`);
          resolve(switchState === 'on');
        } else {
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }
      });
    });
  }

  async setLevel(value: CharacteristicValue): Promise<void> {
    this.log.debug('Received setLevel(' + value + ') event for ' + this.name);

    return new Promise<void>((resolve, reject) => {
      if (!this.multiServiceAccessory.isOnline()) {
        this.log.error(this.accessory.context.device.label + ' is offline');
        return reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
      }

      this.multiServiceAccessory.sendCommand('switchLevel', 'setLevel', [value]).then(success => {
        if (success) {
          this.log.debug('setLevel(' + value + ') SUCCESSFUL for ' + this.name);
          resolve();
        } else {
          this.log.error(`Failed to send setLevel command for ${this.name}`);
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }
      });
    });
  }

  async getLevel(): Promise<CharacteristicValue> {
    this.log.debug('Received getLevel() event for ' + this.name);
    let level = 0;

    return new Promise<CharacteristicValue>((resolve, reject) => {
      if (!this.multiServiceAccessory.isOnline()) {
        this.log.error(this.accessory.context.device.label + ' is offline');
        return reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
      }
      this.multiServiceAccessory.refreshStatus().then((success) => {
        if (!success) {
          this.log.error(`Could not get device status for ${this.name}`);
          return reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }

        if (this.deviceStatus.status.switchLevel.level.value !== undefined) {
          level = this.deviceStatus.status.switchLevel.level.value;
          this.log.debug('getLevel() SUCCESSFUL for ' + this.name + '. value = ' + level);
          resolve(level);
        } else {
          this.log.error('getLevel() FAILED for ' + this.name + '. Undefined value');
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }
      });
    });
  }

  async setColorTemp(value: CharacteristicValue): Promise<void> {
    this.log.debug(`Set Color Temperature received with value ${value}`);

    return new Promise((resolve, reject) => {
      if (!this.multiServiceAccessory.isOnline()) {
        this.log.error(this.accessory.context.device.label + ' is offline');
        return reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
      }
      const stValue = Math.max(2200, Math.min(9000, Math.round(1000000 / (value as number))));
      this.log.debug(`Sending converted temperature value of ${stValue} to ${this.name}`);
      this.multiServiceAccessory.sendCommand('colorTemperature', 'setColorTemperature', [stValue])
        .then(() => {
          const calc = this.platform.api.hap.ColorUtils.colorTemperatureToHueAndSaturation( value as number );
          this.service.getCharacteristic( this.platform.Characteristic.Saturation ).updateValue( calc.saturation );
          this.service.getCharacteristic( this.platform.Characteristic.Hue ).updateValue( calc.hue );
          resolve();
        })
        .catch((value) => reject(value));
    });
  }

  async getColorTemp(): Promise<CharacteristicValue> {
    return new Promise((resolve, reject) => {
      this.multiServiceAccessory.refreshStatus().then((success) => {
        if (!success) {
          //this.online = false;
          this.log.error(`Could not get device status for ${this.name}`);
          return reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }

        if (this.deviceStatus.status.colorTemperature.colorTemperature.value !== undefined) {
          const value = Math.max(2200, Math.min(this.deviceStatus.status.colorTemperature.colorTemperature.value, 9000));
          // Convert number to the homebridge compatible value, using mired value
          // https://developer.apple.com/documentation/homekit/hmcharacteristictypecolortemperature
          const hbTemperature = Math.round(1000000 / value);
          this.log.debug('getColorTemperature() SUCCESSFUL for ' + this.name + '. value = ' + value + ' converted to ' + hbTemperature);

          resolve(hbTemperature);
        } else {
          this.log.error('getColorTemperature() FAILED for ' + this.name + '. Undefined value');
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }

      });
    });
  }

  private async getHueSaturationValues(): Promise< CharacteristicValue > {
    return new Promise((resolve, reject) => {
      this.multiServiceAccessory.refreshStatus().then((success) => {
        if (!success) {
          this.log.error(`Could not get device status for ${this.name}`);
          return reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }

        const colorTempTimestamp = this.deviceStatus.status.colorTemperature.colorTemperature.timestamp;
        const colorHueTimestamp = this.deviceStatus.status.colorControl.hue.timestamp;
        const colorSaturationTimestamp = this.deviceStatus.status.colorControl.saturation.timestamp;

        let saturation = this.deviceStatus.status.colorControl.saturation.value;
        let hue = this.deviceStatus.status.colorControl.hue.value;
        if (hue !== undefined) {
          hue =  Math.round((hue / 100) * 360);
        }
        if (colorTempTimestamp !== undefined && (colorHueTimestamp !== undefined || colorSaturationTimestamp !== undefined)) {
          const colorTempDate = new Date(colorTempTimestamp);
          const colorHueDate = new Date(colorHueTimestamp);
          const colorSaturationDate = new Date(colorSaturationTimestamp);
          const colorDate = colorHueDate > colorSaturationDate ? colorHueDate : colorSaturationDate;

          // If color temperature change was more recent than hue/saturation, then we must convert the current color temp to hue/sat rather
          // than using the old invalid value. It seems that HomeKit prioritizes Hue/Sat over Color Temp when using the get methods.
          if (colorTempDate > colorDate) {
            const colorTemperature = this.deviceStatus.status.colorTemperature.colorTemperature.value;
            const colorTemp = Math.max(2200, Math.min(colorTemperature, 9000));
            const hbTemperature = Math.round(1000000 / colorTemp);
            const calc = this.platform.api.hap.ColorUtils.colorTemperatureToHueAndSaturation(hbTemperature);
            hue = calc.hue;
            saturation = calc.saturation;
          }
        }

        resolve({hue, saturation});
      });
    });
  }

  async setHue(value: CharacteristicValue): Promise<void> {
    this.log.debug(`setHue called with value ${value}`);
    const huePct = Math.round((value as number / 360) * 100);
    this.log.debug(`Hue arc value of ${value} converted to Hue Percent of ${huePct}`);
    this.deferredHue = huePct;
    return this.setColor();
  }

  async getHue(): Promise < CharacteristicValue > {
    return new Promise((resolve, reject) => {
      this.getHueSaturationValues().then((color) => {
        const result = color as {[key: string]: PrimitiveTypes};
        if (result.hue !== undefined) {
          this.log.debug('getHue() SUCCESSFUL for ' + this.name + '. value = ' + result.hue);
          resolve(result.hue);
        } else {
          this.log.error('getHue() FAILED for ' + this.name + '. Undefined value');
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }
      }).catch(() => {
        this.log.error('getHue() FAILED for ' + this.name + '. Comm error.');
        reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
      });
    });
  }

  async setSaturation(value: CharacteristicValue): Promise<void> {
    this.log.debug(`setSaturation called with value ${value}`);
    this.deferredSaturation = value;
    return this.setColor();
  }

  async getSaturation(): Promise < CharacteristicValue > {
    return new Promise((resolve, reject) => {
      this.getHueSaturationValues().then((color) => {
        const result = color as {[key: string]: PrimitiveTypes};
        if (result.saturation !== undefined) {
          this.log.debug('getSaturation() SUCCESSFUL for ' + this.name + '. value = ' + result.saturation);
          resolve(result.saturation);
        } else {
          this.log.error('getSaturation() FAILED for ' + this.name + '. Undefined value');
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }
      }).catch(() => {
        this.log.error('getSaturation() FAILED for ' + this.name + '. Comm error.');
        reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
      });
    });
  }

  async setColor(): Promise<void> {
    if (this.deferredHue === undefined || this.deferredSaturation === undefined) {
      return new Promise((resolve) => {
        this.log.debug('setColor invoked, with either hue or saturation undefined.');

        resolve();
      });
    }

    this.log.debug(`setColor invoked with saturation: ${this.deferredSaturation}, hue: ${this.deferredHue}`);

    return new Promise((resolve, reject) => {
      this.multiServiceAccessory.sendCommand('colorControl', 'setColor', [{saturation: this.deferredSaturation, hue: this.deferredHue}])
        .then(() => resolve())
        .catch((value) => reject(value))
        .finally(() => {
          this.deferredHue = undefined;
          this.deferredSaturation = undefined;
        });
    });
  }
}