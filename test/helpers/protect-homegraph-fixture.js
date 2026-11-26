// Captured Protect schema with fabricated identities and dates for mapping/lifecycle checks.
import { getResourceKey } from '../../src/utils.js';
import { DATA_SOURCE } from '../../src/consts.js';

export function protectHomeGraphFixture(model = 'NEST_PROTECT_2_LINE.9') {
  return {
    [getResourceKey('account', 'HomeGraph', 'home', 'STRUCTURE')]: {
      source: DATA_SOURCE.HOMEGRAPH,
      connection: 'account',
      value: {
        home: {
          uuid: 'home',
          name: 'Fixture',
          rooms: [{ uuid: 'room', name: 'Hallway' }],
          traits: [
            {
              name: 'home.platform.traits.StructureSelfTestTrait',
              fields: {
                manualTest: {
                  structValue: {
                    fields: {
                      status: { stringValue: 'SELF_TEST_STATUS_COMPLETED' },
                      endTime: { stringValue: '1785047209' },
                      lastSuccessfulTestTimeSeconds: { stringValue: '1785047210' },
                    },
                  },
                },
                audioTest: { structValue: { fields: { endTime: { stringValue: '1785047300' } } } },
              },
            },
          ],
        },
      },
    },
    [getResourceKey('account', 'HomeGraph', 'protect')]: {
      source: DATA_SOURCE.HOMEGRAPH,
      connection: 'account',
      value: {
        googleHome: {
          id: { googleUuid: 'protect', thirdPartyId: { idType: 'nest-home-assistant-prod' } },
          type: 'action.devices.types.SMOKE_DETECTOR',
          displayName: 'Hallway',
          hardware: { model: 'Nest Protect', softwareVersion: '5.0rc38' },
        },
        structureId: 'home',
        roomId: 'room',
        technicalInformation: { serialNumber: '06TESTPROTECT', model },
        attributes: {
          fields: {
            expiryDate: { stringValue: '1887519600' },
            supportedEnergySources: {
              listValue: {
                values: (model.includes('_LINE.') === true ? ['WIRE', 'BATTERY'] : ['BATTERY']).map((stringValue) => ({ stringValue })),
              },
            },
          },
        },
        'deviceStatus.online': { boolean: true },
        'charging.descriptiveCapacityRemaining': { text: 'full' },
        'sensorState.currentSensorStateData': {
          array: {
            values: [
              ['SmokeLevel', 'no smoke detected'],
              ['CarbonMonoxideLevel', 'no carbon monoxide detected'],
            ].map(([name, state]) => ({
              properties: {
                properties: [
                  { name: 'name', value: { text: name } },
                  { name: 'currentSensorState', value: { text: state } },
                  { name: 'alarmState', value: { text: 'IDLE' } },
                  { name: 'alarmSilenceState', value: { text: 'DISALLOWED' } },
                ],
              },
            })),
          },
        },
      },
    },
  };
}

export function protectSensorProperty(raw, sensor, name, value) {
  let entry =
    raw[getResourceKey('account', 'HomeGraph', 'protect')].value['sensorState.currentSensorStateData'].array.values[sensor].properties
      .properties;
  entry.find((property) => property.name === name).value = { text: value };
}
