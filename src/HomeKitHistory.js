// HomeKit history service
// Simple history service for HomeKit developed accessories with HAP-NodeJS
//
// todo (EveHome integration)
// -- get history to show for motion when attached to a smoke sensor
// -- get history to show for smoke when attached to a smoke sensor
// -- thermo valve protection
// -- Eve Degree/Weather2 history
// -- Eve Water guard history
//
// Version 11/8/2024
// Mark Hulskamp

// Define HAP-NodeJS requirements
import HAP from 'hap-nodejs';

// Define nodejs module requirements
import { setTimeout } from 'node:timers';
import { Buffer } from 'node:buffer';
import util from 'util';
import fs from 'fs';

// Define constants
const MAX_HISTORY_SIZE = 16384;                                                 // 16k entries
const EPOCH_OFFSET = 978307200;                                                 // Seconds since 1/1/1970 to 1/1/2001
const EVEHOME_MAX_STREAM = 11;                                                  // Maximum number of history events we can stream to EveHome
const DAYSOFWEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];


// Create the history object
export default class HomeKitHistory {
    log = undefined;
    maxEntries = MAX_HISTORY_SIZE; // used for rolling history. if 0, means no rollover
    EveHome = undefined;

    constructor(accessory, options) {
        if (typeof options === 'object') {
            if (typeof options?.maxEntries === 'number') {
                this.maxEntries = options.maxEntries; // used for rolling history. if 0, means no rollover
            }

            if (typeof options?.log?.info === 'function' &&
                typeof options?.log?.success === 'function' &&
                typeof options?.log?.warn === 'function' &&
                typeof options?.log?.error === 'function' &&
                typeof options?.log?.debug === 'function') {

                this.log = options.log;
            }
        }

        // Setup HomeKitHistory using HAP-NodeJS library
        if (typeof accessory?.username !== 'undefined') {
            // Since we have a username for the accessory, we'll assume this is not running under Homebridge
            // We'll use it's persist folder for storing history files
            this.storageKey = util.format('History.%s.json', accessory.username.replace(/:/g, '').toUpperCase());
            this.storage = HAP.HAPStorage.storage();
        }

        // Setup HomeKitHistory using Homebridge library
        if (typeof accessory?.username === 'undefined' &&
            typeof options?.api?.hap?.HAPStorage?.storage === 'function') {

            this.storageKey = util.format('History.%s.json', accessory.UUID);
            this.storage = options.api.hap.HAPStorage.storage();
        }

        this.historyData = this.storage.getItem(this.storageKey);
        if (typeof this.historyData !== 'object') {
            // Getting storage key didnt return an object, we'll assume no history present, so start new history for this accessory
            this.resetHistory();    // Start with blank history
        }

        this.restart = Math.floor(Date.now() / 1000);   // time we restarted

        // perform rollover if needed when starting service
        if (this.maxEntries !== 0 && this.historyData.next >= this.maxEntries) {
            this.rolloverHistory();
        }
    }

    // Class functions
    addHistory(service, entry, timegap) {
        // we'll use the service or characteristic UUID to determine the history entry time and data we'll add
        // reformat the entry object to order the fields consistantly in the output
        // Add new history types in the switch statement
        let historyEntry = {};
        if (this.restart !== null && typeof entry.restart === 'undefined') {
            // Object recently created, so log the time restarted our history service
            entry.restart = this.restart;
            this.restart = null;
        }
        if (typeof entry.time === 'undefined') {
            // No logging time was passed in, so set
            entry.time = Math.floor(Date.now() / 1000);
        }
        if (typeof service.subtype === 'undefined') {
            service.subtype = 0;
        }
        if (typeof timegap === 'undefined') {
            timegap = 0; // Zero minimum time gap between entries
        }
        switch (service.UUID) {
            case HAP.Service.GarageDoorOpener.UUID : {
                // Garage door history
                // entry.time => unix time in seconds
                // entry.status => 0 = closed, 1 = open
                historyEntry.status = entry.status;
                if (typeof entry.restart !== 'undefined') {
                    historyEntry.restart = entry.restart;
                }
                this.#addEntry(service.UUID, service.subtype, entry.time, timegap, historyEntry);
                break;
            }

            case HAP.Service.MotionSensor.UUID : {
                // Motion sensor history
                // entry.time => unix time in seconds
                // entry.status => 0 = motion cleared, 1 = motion detected
                historyEntry.status = entry.status;
                if (typeof entry.restart !== 'undefined') {
                    historyEntry.restart = entry.restart;
                }
                this.#addEntry(service.UUID, service.subtype, entry.time, timegap, historyEntry);
                break;
            }

            case HAP.Service.Window.UUID :
            case HAP.Service.WindowCovering.UUID : {
                // Window and Window Covering history
                // entry.time => unix time in seconds
                // entry.status => 0 = closed, 1 = open
                // entry.position => position in % 0% = closed 100% fully open
                historyEntry.status = entry.status;
                historyEntry.position = entry.position;
                if (typeof entry.restart !== 'undefined') {
                    historyEntry.restart = entry.restart;
                }
                this.#addEntry(service.UUID, service.subtype, entry.time, timegap, historyEntry);
                break;
            }

            case HAP.Service.HeaterCooler.UUID :
            case HAP.Service.Thermostat.UUID : {
                // Thermostat and Heater/Cooler history
                // entry.time => unix time in seconds
                // entry.status => 0 = off, 1 = fan, 2 = heating, 3 = cooling, 4 = dehumidifying
                // entry.temperature  => current temperature in degress C
                // entry.target => {low, high} = cooling limit, heating limit
                // entry.humidity => current humidity
                historyEntry.status = entry.status;
                historyEntry.temperature = entry.temperature;
                historyEntry.target = entry.target;
                historyEntry.humidity = entry.humidity;
                if (typeof entry.restart !== 'undefined') {
                    historyEntry.restart = entry.restart;
                }
                this.#addEntry(service.UUID, service.subtype, entry.time, timegap, historyEntry);
                break;
            }

            case HAP.Service.EveAirPressureSensor.UUID :
            case HAP.Service.AirQualitySensor.UUID :
            case HAP.Service.TemperatureSensor.UUID : {
                // Temperature sensor history
                // entry.time => unix time in seconds
                // entry.temperature => current temperature in degress C
                // entry.humidity => current humidity
                // optional (entry.ppm)
                // optional (entry.voc => current VOC measurement in ppb)\
                // optional (entry.pressure -> in hpa)
                historyEntry.temperature = entry.temperature;
                if (typeof entry.humidity === 'undefined') {
                    // fill out humidity if missing
                    entry.humidity = 0;
                }
                if (typeof entry.ppm === 'undefined') {
                    // fill out ppm if missing
                    entry.ppm = 0;
                }
                if (typeof entry.voc === 'undefined') {
                    // fill out voc if missing
                    entry.voc = 0;
                }
                if (typeof entry.pressure === 'undefined') {
                    // fill out pressure if missing
                    entry.pressure = 0;
                }
                historyEntry.temperature = entry.temperature;
                historyEntry.humidity = entry.humidity;
                historyEntry.ppm = entry.ppm;
                historyEntry.voc = entry.voc;
                historyEntry.pressure = entry.pressure;
                if (typeof entry.restart !== 'undefined') {
                    historyEntry.restart = entry.restart;
                }
                this.#addEntry(service.UUID, service.subtype, entry.time, timegap, historyEntry);
                break;
            }

            case HAP.Service.Valve.UUID : {
                // Water valve history
                // entry.time => unix time in seconds
                // entry.status => 0 = valve closed, 1 = valve opened
                // entry.water => amount of water in L's
                // entry.duration => time for water amount
                historyEntry.status = entry.status;
                historyEntry.water = entry.water;
                historyEntry.duration = entry.duration;
                if (typeof entry.restart !== 'undefined') {
                    historyEntry.restart = entry.restart;
                }
                this.#addEntry(service.UUID, service.subtype, entry.time, timegap, historyEntry);
                break;
            }

            case HAP.Characteristic.WaterLevel.UUID : {
                // Water level history
                // entry.time => unix time in seconds
                // entry.level => water level as percentage
                historyEntry.level = entry.level;
                if (typeof entry.restart !== 'undefined') {
                    historyEntry.restart = entry.restart;
                }
                this.#addEntry(service.UUID, 0, entry.time, timegap, historyEntry); // Characteristics don't have sub type, so we'll use 0 for it
                break;
            }

            case HAP.Service.LeakSensor.UUID : {
                // Leak sensor history
                // entry.time => unix time in seconds
                // entry.status => 0 = no leak, 1 = leak
                historyEntry.status = entry.status;
                if (typeof entry.restart !== 'undefined') {
                    historyEntry.restart = entry.restart;
                }
                this.#addEntry(service.UUID, 0, entry.time, timegap, historyEntry); // Characteristics don't have sub type, so we'll use 0 for it
                break;
            }

            case HAP.Service.Outlet.UUID : {
                // Power outlet history
                // entry.time => unix time in seconds
                // entry.status => 0 = off, 1 = on
                // entry.volts  => voltage in Vs
                // entry.watts  => watts in W's
                // entry.amps  => current in A's
                historyEntry.status = entry.status;
                historyEntry.volts = entry.volts;
                historyEntry.watts = entry.watts;
                historyEntry.amps = entry.amps;
                if (typeof entry.restart !== 'undefined') {
                    historyEntry.restart = entry.restart;
                }
                this.#addEntry(service.UUID, service.subtype, entry.time, timegap, historyEntry);
                break;
            }

            case HAP.Service.Doorbell.UUID : {
                // Doorbell press history
                // entry.time => unix time in seconds
                // entry.status => 0 = not pressed, 1 = doorbell pressed
                historyEntry.status = entry.status;
                if (typeof entry.restart !== 'undefined') {
                    historyEntry.restart = entry.restart;
                }
                this.#addEntry(service.UUID, service.subtype, entry.time, timegap, historyEntry);
                break;
            }

            case HAP.Service.SmokeSensor.UUID : {
                // Smoke sensor history
                // entry.time => unix time in seconds
                // entry.status => 0 = smoke cleared, 1 = smoke detected
                historyEntry.status = entry.status;
                if (typeof historyEntry.restart !== 'undefined') {
                    historyEntry.restart = entry.restart;
                }
                this.#addEntry(service.UUID, service.subtype, entry.time, timegap, historyEntry);
                break;
            }
        }
    }

    resetHistory() {
        // Reset history to nothing
        this.historyData = {};
        this.historyData.reset = Math.floor(Date.now() / 1000); // time history was reset
        this.historyData.rollover = 0;  // no last rollover time
        this.historyData.next = 0;      // next entry for history is at start
        this.historyData.types = [];    // no service types in history
        this.historyData.data = [];     // no history data
        this.storage.setItem(this.storageKey, this.historyData);
    }

    rolloverHistory() {
        // Roll history over and start from zero.
        // We'll include an entry as to when the rollover took place
        // remove all history data after the rollover entry
        this.historyData.data.splice(this.maxEntries, this.historyData.data.length);
        this.historyData.rollover = Math.floor(Date.now() / 1000);
        this.historyData.next = 0;
        this.#updateHistoryTypes();
        this.storage.setItem(this.storageKey, this.historyData);
    }

    #addEntry(type, sub, time, timegap, entry) {
        let historyEntry = {};
        let recordEntry = true; // always record entry unless we don't need to
        historyEntry.time = time;
        historyEntry.type = type;
        historyEntry.sub = sub;
        Object.entries(entry).forEach(([key, value]) => {
            if (key !== 'time' || key !== 'type' || key !== 'sub') {
                // Filer out events we want to control
                historyEntry[key] = value;
            }
        });

        // If we have a minimum time gap specified, find the last time entry for this type and if less than min gap, ignore
        if (timegap !== 0) {
            let typeIndex = this.historyData.types.findIndex(type => (type.type === historyEntry.type && type.sub === historyEntry.sub));
            if (typeIndex >= 0 &&
                (time - this.historyData.data[this.historyData.types[typeIndex].lastEntry].time < timegap) &&
                typeof historyEntry.restart === 'undefined') {

                // time between last recorded entry and new entry is less than minimum gap and its not a 'restart' entry
                // so don't log it
                recordEntry = false;
            }
        }

        if (recordEntry === true) {
            // Work out where this goes in the history data array
            if (this.maxEntries !== 0 && this.historyData.next >= this.maxEntries) {
                // roll over history data as we've reached the defined max entry size
                this.rolloverHistory();
            }
            this.historyData.data[this.historyData.next] = historyEntry;
            this.historyData.next++;

            // Update types we have in history. This will just be the main type and its latest location in history
            let typeIndex = this.historyData.types.findIndex(type => (type.type === historyEntry.type && type.sub === historyEntry.sub));
            if (typeIndex === -1) {
                this.historyData.types.push({type: historyEntry.type, sub: historyEntry.sub, lastEntry: (this.historyData.next - 1)});
            } else {
                this.historyData.types[typeIndex].lastEntry = (this.historyData.next - 1);
            }

            // Validate types last entries. Helps with rolled over data etc. If we cannot find the type anymore, remove from known types
            this.historyData.types.forEach((typeEntry, index) => {
                if (this.historyData.data[typeEntry.lastEntry].type !== typeEntry.type) {
                    // not found, so remove from known types
                    this.historyData.types.splice(index, 1);
                }
            });

            this.storage.setItem(this.storageKey, this.historyData); // Save to persistent storage
        }
    }

    getHistory(service, subtype, specifickey) {
        // returns a JSON object of all history for this service and subtype
        // handles if we've rolled over history also
        let tempHistory = [];
        let findUUID = null;
        let findSub = null;
        if (typeof subtype !== 'undefined' && subtype !== null) {
            findSub = subtype;
        }
        if (typeof service !== 'object') {
            // passed in UUID byself, rather than service object
            findUUID = service;
        }
        if (typeof service?.UUID === 'string') {
            findUUID = service.UUID;
        }
        if (typeof service.subtype === 'undefined' && typeof subtype === 'undefined') {
            findSub = 0;
        }
        tempHistory = tempHistory.concat(this.historyData.data.slice(this.historyData.next, this.historyData.data.length), this.historyData.data.slice(0, this.historyData.next));
        tempHistory = tempHistory.filter(historyEntry => {
            if (typeof specifickey === 'object' && Object.keys(specifickey).length === 1) {
                // limit entry to a specifc key type value if specified
                if ((findSub === null &&
                    historyEntry.type === findUUID &&
                    historyEntry[Object.keys(specifickey)] === Object.values(specifickey)) ||
                    (findSub !== null &&
                    historyEntry.type === findUUID &&
                    historyEntry.sub === findSub &&
                    historyEntry[Object.keys(specifickey)] === Object.values(specifickey))) {

                    return historyEntry;
                }
            } else if ((findSub === null &&
                        historyEntry.type === findUUID) ||
                        (findSub !== null &&
                        historyEntry.type === findUUID &&
                        historyEntry.sub === findSub)) {

                return historyEntry;
            }
        });
        return tempHistory;
    }

    generateCSV(service, csvfile) {
        // Generates a CSV file for use in applications such as Numbers/Excel for graphing
        // we get all the data for the service, ignoring the specific subtypes
        let tempHistory = this.getHistory(service, null); // all history
        if (tempHistory.length !== 0) {
            let writer = fs.createWriteStream(csvfile, {flags: 'w', autoClose: 'true'});
            if (writer !== null) {
                // write header, we'll use the first record keys for the header keys
                let header = 'time,subtype';
                Object.keys(tempHistory[0]).forEach(key => {
                    if (key !== 'time' && key !== 'type' && key !== 'sub' && key !== 'restart') {
                        header = header + ',' + key;
                    }
                });
                writer.write(header + '\n');

                // write data
                // Date/Time converted into local timezone
                tempHistory.forEach(historyEntry => {
                    let csvline = new Date(historyEntry.time * 1000).toLocaleString().replace(',', '') + ',' + historyEntry.sub;
                    Object.entries(historyEntry).forEach(([key, value]) => {
                        if (key !== 'time' && key !== 'type' && key !== 'sub' && key !== 'restart') {
                            csvline = csvline + ',' + value;
                        }
                    });
                    writer.write(csvline + '\n');
                });
                writer.end();
            }
        }
    }

    lastHistory(service, subtype) {
        // returns the last history event for this service type and subtype
        let findUUID = null;
        let findSub = null;
        if (typeof subtype !== 'undefined') {
            findSub = subtype;
        }
        if (typeof service !== 'object') {
            // passed in UUID byself, rather than service object
            findUUID = service;
        }
        if (typeof service?.UUID === 'string') {
            findUUID = service.UUID;
        }
        if (typeof service.subtype === 'undefined' && typeof subtype === 'undefined') {
            findSub = 0;
        }

        // If subtype is 'null' find newest event based on time
        let typeIndex = this.historyData.types.findIndex(type => ((type.type === findUUID && type.sub === findSub && subtype !== null) || (type.type === findUUID && subtype === null)));
        return (typeIndex !== -1 ? this.historyData.data[this.historyData.types[typeIndex].lastEntry] : null);
    }

    entryCount(service, subtype, specifickey) {
        // returns the number of history entries for this service type and subtype
        // can can also be limited to a specific key value
        let tempHistory = this.getHistory(service, subtype, specifickey);
        return tempHistory.length;
    }

    #updateHistoryTypes() {
        // Builds the known history types and last entry in current history data
        // Might be time consuming.....
        this.historyData.types = [];
        for (let index = (this.historyData.data.length - 1); index > 0; index--) {
            if (this.historyData.types.findIndex(type => ((typeof type.sub !== 'undefined' && type.type === this.historyData.data[index].type && type.sub === this.historyData.data[index].sub) || (typeof type.sub === 'undefined' && type.type === this.historyData.data[index].type))) === -1) {
                this.historyData.types.push({type: this.historyData.data[index].type, sub: this.historyData.data[index].sub, lastEntry: index});
            }
        }
    }

    // Overlay EveHome service, characteristics and functions
    // Alot of code taken from fakegato https://github.com/simont77/fakegato-history
    // references from https://github.com/ebaauw/homebridge-lib/blob/master/lib/EveHomeKitTypes.js
    //

    // Overlay our history into EveHome. Can only have one service history exposed to EveHome (ATM... see if can work around)
    // Returns object created for our EveHome accessory if successfull
    linkToEveHome(accessory, service, options) {
        if (typeof accessory !== 'object' ||
            typeof service !== 'object' ||
            typeof this?.EveHome?.service !== 'undefined') {

            return;
        }

        if (typeof options !== 'object') {
            options = {};
        }

        switch (service.UUID) {
            case HAP.Service.ContactSensor.UUID :
            case HAP.Service.Door.UUID :
            case HAP.Service.Window.UUID :
            case HAP.Service.GarageDoorOpener.UUID : {
                // treat these as EveHome Door
                // Inverse status used for all UUID types except HAP.Service.ContactSensor.UUID

                // Setup the history service if not already present on the accessory
                let historyService = accessory.getService(HAP.Service.EveHomeHistory);
                if (historyService === undefined) {
                    historyService = accessory.addService(HAP.Service.EveHomeHistory, '', 1);
                }
                if (service.testCharacteristic(HAP.Characteristic.EveLastActivation) === false) {
                    service.addCharacteristic(HAP.Characteristic.EveLastActivation);
                }
                if (service.testCharacteristic(HAP.Characteristic.EveOpenDuration) === false) {
                    service.addCharacteristic(HAP.Characteristic.EveOpenDuration);
                }
                if (service.testCharacteristic(HAP.Characteristic.EveClosedDuration) === false) {
                    service.addCharacteristic(HAP.Characteristic.EveClosedDuration);
                }
                if (service.testCharacteristic(HAP.Characteristic.EveTimesOpened) === false) {
                    service.addCharacteristic(HAP.Characteristic.EveTimesOpened);
                }

                let tempHistory = this.getHistory(service.UUID, service.subtype);
                let historyreftime = (this.historyData.reset - EPOCH_OFFSET);
                if (tempHistory.length !== 0) {
                    historyreftime = (tempHistory[0].time - EPOCH_OFFSET);
                }

                this.EveHome = {
                    'service': historyService,
                    'linkedservice': service,
                    'type': service.UUID,
                    'sub': service.subtype,
                    'evetype': (service.UUID === HAP.Service.ContactSensor.UUID ? 'contact' : 'door'),
                    'fields': '0601',
                    'entry': 0,
                    'count': tempHistory.length,
                    'reftime': historyreftime,
                    'send': 0,
                };

                // Setup initial values and callbacks for charateristics we are using
                service.updateCharacteristic(HAP.Characteristic.EveTimesOpened, this.entryCount(this.EveHome.type, this.EveHome.sub, {status: 1}));   // Count of entries based upon status = 1, opened
                service.updateCharacteristic(HAP.Characteristic.EveLastActivation, this.#EveLastEventTime()); // time of last event in seconds since first event

                // Setup callbacks for characteristics
                service.getCharacteristic(HAP.Characteristic.EveTimesOpened).onGet(() => {
                    return this.entryCount(this.EveHome.type, this.EveHome.sub, {status: 1});  // Count of entries based upon status = 1, opened
                });

                service.getCharacteristic(HAP.Characteristic.EveLastActivation).onGet(() => {
                    return this.#EveLastEventTime();  // time of last event in seconds since first event
                });
                break;
            }

            case HAP.Service.WindowCovering.UUID :
            {
                // Treat as Eve MotionBlinds

                // Setup the history service if not already present on the accessory
                let historyService = accessory.getService(HAP.Service.EveHomeHistory);
                if (historyService === undefined) {
                    historyService = accessory.addService(HAP.Service.EveHomeHistory, '', 1);
                }
                if (service.testCharacteristic(HAP.Characteristic.EveGetConfiguration) === false) {
                    service.addCharacteristic(HAP.Characteristic.EveGetConfiguration);
                }
                if (service.testCharacteristic(HAP.Characteristic.EveSetConfiguration) === false) {
                    service.addCharacteristic(HAP.Characteristic.EveSetConfiguration);
                }

                let tempHistory = this.getHistory(service.UUID, service.subtype);
                let historyreftime = (this.historyData.reset - EPOCH_OFFSET);
                if (tempHistory.length !== 0) {
                    historyreftime = (tempHistory[0].time - EPOCH_OFFSET);
                }

                this.EveHome = {
                    'service': historyService,
                    'linkedservice': service,
                    'type': service.UUID,
                    'sub': service.subtype,
                    'evetype': 'blind',
                    'fields': '1702 1802 1901',
                    'entry': 0,
                    'count': tempHistory.length,
                    'reftime': historyreftime,
                    'send': 0,
                };

                //17      CurrentPosition
                //18      TargetPosition
                //19      PositionState

                /*  let index = 80;
                let uuid = 'E863F1' + numberToEveHexString(index, 2) + '-079E-48FF-8F27-9C2605A29F52'.toLocaleUpperCase();
                eval(`HAP.Characteristic.EveTest`+ index + ` =function() {HAP.Characteristic.call(this, 'Eve Test '+ index, uuid); this.setProps({format: HAP.Formats.DATA,perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY]});this.value = this.getDefaultValue();}`);
                util.inherits(eval(`HAP.Characteristic.EveTest`+ index), HAP.Characteristic);
                eval(`HAP.Characteristic.EveTest`+ index + `.UUID = uuid`);
                if (service.testCharacteristic(eval(`HAP.Characteristic.EveTest`+ index)) === false) {
                    service.addCharacteristic(eval(`HAP.Characteristic.EveTest`+ index));
                    console.log(uuid)
                } */


                service.getCharacteristic(HAP.Characteristic.EveGetConfiguration).onGet(() => {
                    let value = util.format(
                        '0002 5500 0302 %s 9b04 %s 1e02 5500 0c',
                        numberToEveHexString(2979, 4),  // firmware version (build xxxx)
                        numberToEveHexString(Math.floor(Date.now() / 1000), 8)); // 'now' time

                    return encodeEveData(value);
                });

                service.getCharacteristic(HAP.Characteristic.EveSetConfiguration).onSet((value) => {
                    //let processedData = {};
                    let valHex = decodeEveData(value);
                    let index = 0;

                    //console.log('EveSetConfiguration', valHex);

                    while (index < valHex.length) {
                        // first byte is command in this data stream
                        // second byte is size of data for command
                        let command = valHex.substr(index, 2);
                        let size = parseInt(valHex.substr(index + 2, 2), 16) * 2;
                        let data = valHex.substr(index + 4, parseInt(valHex.substr(index + 2, 2), 16) * 2);
                        switch(command) {
                            case '00' : {
                                // end of command?
                                break;
                            }

                            case 'f0' : {
                                // set limits
                                // data
                                // 02 bottom position set
                                // 01 top position set
                                // 04 favourite position set
                                break;
                            }

                            case 'f1' : {
                                // orientation set??
                                break;
                            }

                            case 'f3' : {
                                // move window covering to set limits
                                // xxyyyy - xx = move command (01 = up, 02 = down, 03 = stop), yyyy - distance/time/ticks/increment to move??
                                //let moveCommand = data.substring(0, 2);
                                //let moveAmount = EveHexStringToNumber(data.substring(2));

                                //console.log('move', moveCommand, moveAmount);

                                let currentPosition = service.getCharacteristic(HAP.Characteristic.CurrentPosition).value;
                                if (data === '015802') {
                                    currentPosition = currentPosition + 1;
                                }
                                if (data === '025802') {
                                    currentPosition = currentPosition - 1;
                                }
                                //console.log('move', currentPosition, data);
                                service.updateCharacteristic(HAP.Characteristic.CurrentPosition, currentPosition);
                                service.updateCharacteristic(HAP.Characteristic.TargetPosition, currentPosition);
                                break;
                            }

                            default : {
                                this?.log?.debug && this.log.debug('Unknown Eve MotionBlinds command "%s" with data "%s"', command, data);
                                break;
                            }
                        }
                        index += (4 + size);  // Move to next command accounting for header size of 4 bytes
                    }
                });
                break;
            }

            case HAP.Service.HeaterCooler.UUID :
            case HAP.Service.Thermostat.UUID : {
                // treat these as EveHome Thermo

                // Setup the history service if not already present on the accessory
                let historyService = accessory.getService(HAP.Service.EveHomeHistory);
                if (historyService === undefined) {
                    historyService = accessory.addService(HAP.Service.EveHomeHistory, '', 1);
                }
                if (service.testCharacteristic(HAP.Characteristic.EveValvePosition) === false) {
                    // Needed to show history for thermostat heating modes (valve position)
                    service.addCharacteristic(HAP.Characteristic.EveValvePosition);
                }
                if (service.testCharacteristic(HAP.Characteristic.EveFirmware) === false) {
                    service.addCharacteristic(HAP.Characteristic.EveFirmware);
                }
                if (service.testCharacteristic(HAP.Characteristic.EveProgramData) === false) {
                    service.addCharacteristic(HAP.Characteristic.EveProgramData);
                }
                if (service.testCharacteristic(HAP.Characteristic.EveProgramCommand) === false) {
                    service.addCharacteristic(HAP.Characteristic.EveProgramCommand);
                }
                if (service.testCharacteristic(HAP.Characteristic.StatusActive) === false) {
                    service.addCharacteristic(HAP.Characteristic.StatusActive);
                }
                if (service.testCharacteristic(HAP.Characteristic.CurrentTemperature) === false) {
                    service.addCharacteristic(HAP.Characteristic.CurrentTemperature);
                }
                if (service.testCharacteristic(HAP.Characteristic.TemperatureDisplayUnits) === false) {
                    service.addCharacteristic(HAP.Characteristic.TemperatureDisplayUnits);
                }
                if (service.testCharacteristic(HAP.Characteristic.LockPhysicalControls) === false) {
                    // Allows childlock toggle to be displayed in Eve App
                    service.addCharacteristic(HAP.Characteristic.LockPhysicalControls);
                }

                let tempHistory = this.getHistory(service.UUID, service.subtype);
                let historyreftime = (this.historyData.reset - EPOCH_OFFSET);
                if (tempHistory.length !== 0) {
                    historyreftime = (tempHistory[0].time - EPOCH_OFFSET);
                }

                this.EveHome = {
                    'service': historyService,
                    'linkedservice': service,
                    'type': service.UUID,
                    'sub': service.subtype,
                    'evetype': 'thermo',
                    'fields': '0102 0202 1102 1001 1201 1d01',
                    'entry': 0,
                    'count': tempHistory.length,
                    'reftime': historyreftime,
                    'send': 0,
                };

                // Need some internal storage to track Eve Thermo configuration from EveHome app
                this.EveThermoPersist = {
                    'firmware': (typeof options?.EveThermo_firmware === 'number' ? options.EveThermo_firmware : 1251), // Firmware version 1251 2015 thermo, 2834 2020 thermo
                    'attached': (options?.EveThermo_attached === true), // attached to base?
                    'tempoffset': (typeof options?.EveThermo_tempoffset === 'number' ? options.EveThermo_tempoffset : -2.5),   // Temperature offset. default -2.5
                    'enableschedule': (options?.EveThermo_enableschedule === true), // Schedules on/off
                    'pause': (options?.EveThermo_pause === true), // Paused on/off
                    'vacation': (options?.EveThermo_vacation === true), // Vacation status - disabled ie: Home
                    'vacationtemp': (typeof options?.EveThermo_vacationtemp === 'number' ? options.EveThermo_vactiontemp : null), // Vacation temp disabled if null
                    'programs': (typeof options?.EveThermo_programs === 'object' ? options.EveThermo_programs : []),
                };

                // Setup initial values and callbacks for charateristics we are using
                service.updateCharacteristic(HAP.Characteristic.EveFirmware, encodeEveData(util.format('2c %s be', numberToEveHexString(this.EveThermoPersist.firmware, 4))));  // firmware version (build xxxx)));

                service.updateCharacteristic(HAP.Characteristic.EveProgramData, this.#EveThermoGetDetails(options.getcommand));
                service.getCharacteristic(HAP.Characteristic.EveProgramData).onGet(() => {
                    return this.#EveThermoGetDetails(options.getcommand);
                });

                service.getCharacteristic(HAP.Characteristic.EveProgramCommand).onSet((value) => {
                    let programs = [];
                    let processedData = {};
                    let valHex = decodeEveData(value);
                    let index = 0;
                    while (index < valHex.length) {
                        let command = valHex.substr(index, 2);
                        index += 2; // skip over command value, and this is where data starts.
                        switch(command) {
                            case '00' : {
                                // start of command string ??
                                break;
                            }

                            case '06' : {
                                // end of command string ??
                                break;
                            }

                            case '7f' : {
                                // end of command string ??
                                break;
                            }

                            case '11' : {
                                // valve calibration/protection??
                                //0011ff00f22076
                                // 00f22076 - 111100100010000001110110
                                //            15868022
                                // 7620f2   - 011101100010000011110010
                                //            7741682
                                //console.log(Math.floor(Date.now() / 1000));
                                index += 10;
                                break;
                            }

                            case '10' : {
                                // OK to remove
                                break;
                            }

                            case '12' : {
                                // temperature offset
                                // 8bit signed value. Divide by 10 to get float value
                                this.EveThermoPersist.tempoffset = EveHexStringToNumber(valHex.substr(index, 2)) / 10;
                                processedData.tempoffset = this.EveThermoPersist.tempoffset;
                                index += 2;
                                break;
                            }

                            case '13' : {
                                // schedules enabled/disable
                                this.EveThermoPersist.enableschedule = valHex.substr(index, 2) === '01' ? true : false;
                                processedData.enableschedule = this.EveThermoPersist.enableschedule;
                                index += 2;
                                break;
                            }

                            case '14' : {
                                // Installed status
                                index += 2;
                                break;
                            }

                            case '18' : {
                                // Pause/resume via HomeKit automation/scene
                                // 20 - pause thermostat operation
                                // 10 - resume thermostat operation
                                this.EveThermoPersist.pause = valHex.substr(index, 2) === '20' ? true : false;
                                processedData.pause = this.EveThermoPersist.pause;
                                index += 2;
                                break;
                            }

                            case '19' : {
                                // Vacation on/off, vacation temperature via HomeKit automation/scene
                                this.EveThermoPersist.vacation = valHex.substr(index, 2) === '01' ? true : false;
                                this.EveThermoPersist.vacationtemp = (valHex.substr(index, 2) === '01' ? parseInt(valHex.substr(index + 2, 2), 16) * 0.5 : null);
                                processedData.vacation = {
                                    'status': this.EveThermoPersist.vacation,
                                    'temp': this.EveThermoPersist.vacationtemp,
                                };
                                index += 4;
                                break;
                            }

                            case 'f4' : {
                                // Temperature Levels for schedule
                                //let nowTemp = valHex.substr(index, 2) === '80' ? null : parseInt(valHex.substr(index, 2), 16) * 0.5;
                                let ecoTemp = valHex.substr(index + 2, 2) === '80' ? null : parseInt(valHex.substr(index + 2, 2), 16) * 0.5;
                                let comfortTemp = valHex.substr(index + 4, 2) === '80' ? null : parseInt(valHex.substr(index + 4, 2), 16) * 0.5;
                                processedData.scheduleTemps = {'eco': ecoTemp, 'comfort': comfortTemp};
                                index += 6;
                                break;
                            }

                            case 'fc' : {
                                // Date/Time mmhhDDMMYY
                                index += 10;
                                break;
                            }

                            case 'fa' : {
                                // Programs (week - mon, tue, wed, thu, fri, sat, sun)
                                // index += 112;
                                for (let index2 = 0; index2 < 7; index2++) {
                                    let times = [];
                                    for (let index3 = 0; index3 < 4; index3++) {
                                        // decode start time
                                        let start = parseInt(valHex.substr(index, 2), 16);
                                        //let start_min = null;
                                        //let start_hr = null;
                                        let start_offset = null;
                                        if (start !== 0xff) {
                                            //start_min = (start * 10) % 60;   // Start minute
                                            //start_hr = ((start * 10) - start_min) / 60;    // Start hour
                                            start_offset = ((start * 10) * 60);    // Seconds since 00:00
                                        }

                                        // decode end time
                                        let end = parseInt(valHex.substr(index + 2, 2), 16);
                                        //let end_min = null;
                                        //let end_hr = null;
                                        let end_offset = null;
                                        if (end !== 0xff) {
                                            //end_min = (end * 10) % 60;   // End minute
                                            //end_hr = ((end * 10) - end_min) / 60;    // End hour
                                            end_offset = ((end * 10) * 60);    // Seconds since 00:00
                                        }

                                        if (start_offset !== null && end_offset !== null) {
                                            times.push({
                                                'start': start_offset,
                                                'duration' : (end_offset - start_offset),
                                                'ecotemp' : processedData.scheduleTemps.eco,
                                                'comforttemp' : processedData.scheduleTemps.comfort,
                                            });
                                        }
                                        index += 4;
                                    }
                                    programs.push({'id': (programs.length + 1), 'days': DAYSOFWEEK[index2], 'schedule': times });
                                }

                                this.EveThermoPersist.programs = programs;
                                processedData.programs = this.EveThermoPersist.programs;
                                break;
                            }

                            case '1a' : {
                                // Program (day)
                                index += 16;
                                break;
                            }

                            case 'f2' : {
                                // ??
                                index += 2;
                                break;
                            }

                            case 'f6' : {
                                //??
                                index += 6;
                                break;
                            }

                            case 'ff' : {
                                // ??
                                index += 4;
                                break;
                            }

                            default : {
                                this?.log?.debug && this.log.debug('Unknown Eve Thermo command "%s"', command);
                                break;
                            }
                        }
                    }

                    // Send complete processed command data if configured to our callback
                    if (typeof options?.setcommand === 'function' && Object.keys(processedData).length !== 0) {
                        options.setcommand(processedData);
                    }
                });
                break;
            }

            case HAP.Service.EveAirPressureSensor.UUID : {
                // treat these as EveHome Weather (2015)

                // Setup the history service if not already present on the accessory
                let historyService = accessory.getService(HAP.Service.EveHomeHistory);
                if (historyService === undefined) {
                    historyService = accessory.addService(HAP.Service.EveHomeHistory, '', 1);
                }
                if (service.testCharacteristic(HAP.Characteristic.EveFirmware) === false) {
                    service.addCharacteristic(HAP.Characteristic.EveFirmware);
                }

                let tempHistory = this.getHistory(service.UUID, service.subtype);
                let historyreftime = (tempHistory.length === 0 ? (this.historyData.reset - EPOCH_OFFSET) : (tempHistory[0].time - EPOCH_OFFSET));
                this.EveHome = {
                    'service': historyService,
                    'linkedservice': service,
                    'type': service.UUID,
                    'sub': service.subtype,
                    'evetype': 'weather',
                    'fields': '0102 0202 0302',
                    'entry': 0,
                    'count': tempHistory.length,
                    'reftime': historyreftime,
                    'send': 0,
                };

                service.updateCharacteristic(HAP.Characteristic.EveFirmware, encodeEveData(util.format('01 %s be', numberToEveHexString(809, 4))));  // firmware version (build xxxx)));
                break;
            }

            case HAP.Service.AirQualitySensor.UUID :
            case HAP.Service.TemperatureSensor.UUID : {
                // treat these as EveHome Room(s)

                // Setup the history service if not already present on the accessory
                let historyService = accessory.getService(HAP.Service.EveHomeHistory);
                if (historyService === undefined) {
                    historyService = accessory.addService(HAP.Service.EveHomeHistory, '', 1);
                }
                if (service.testCharacteristic(HAP.Characteristic.EveFirmware) === false) {
                    service.addCharacteristic(HAP.Characteristic.EveFirmware);
                }

                let tempHistory = this.getHistory(service.UUID, service.subtype);
                let historyreftime = (this.historyData.reset - EPOCH_OFFSET);
                if (tempHistory.length !== 0) {
                    historyreftime = (tempHistory[0].time - EPOCH_OFFSET);
                }

                if (service.UUID === HAP.Service.AirQualitySensor.UUID) {
                    // Eve Room 2 (2018)
                    if (service.testCharacteristic(HAP.Characteristic.VOCDensity) === false) {
                        service.addCharacteristic(HAP.Characteristic.VOCDensity);
                    }

                    this.EveHome = {
                        'service': historyService,
                        'linkedservice': service,
                        'type': service.UUID,
                        'sub': service.subtype,
                        'evetype': 'room2',
                        'fields': '0102 0202 2202 2901 2501 2302 2801',
                        'entry': 0,
                        'count': tempHistory.length,
                        'reftime': historyreftime,
                        'send': 0,
                    };

                    service.updateCharacteristic(HAP.Characteristic.EveFirmware, encodeEveData(util.format('27 %s be', numberToEveHexString(1416, 4))));  // firmware version (build xxxx)));

                    // Need to ensure HomeKit accessory which has Air Quality service also has temperature & humidity services.
                    // Temperature service needs characteristic HAP.Characteristic.TemperatureDisplayUnits set to HAP.Characteristic.TemperatureDisplayUnits.CELSIUS
                }

                if (service.UUID === HAP.Service.TemperatureSensor.UUID) {
                    // Eve Room (2015)
                    if (service.testCharacteristic(HAP.Characteristic.TemperatureDisplayUnits) === false) {
                        service.addCharacteristic(HAP.Characteristic.TemperatureDisplayUnits); // Needed to show history for temperature
                    }

                    this.EveHome = {
                        'service': historyService,
                        'linkedservice': service,
                        'type': service.UUID,
                        'sub': service.subtype,
                        'evetype': 'room',
                        'fields': '0102 0202 0402 0f03',
                        'entry': 0,
                        'count': tempHistory.length,
                        'reftime': historyreftime,
                        'send': 0,
                    };

                    service.updateCharacteristic(HAP.Characteristic.EveFirmware, encodeEveData(util.format('02 %s be', numberToEveHexString(1151, 4))));  // firmware version (build xxxx)));
                    service.updateCharacteristic(HAP.Characteristic.TemperatureDisplayUnits, HAP.Characteristic.TemperatureDisplayUnits.CELSIUS);  // Temperature needs to be in Celsius
                }
                break;
            }

            case HAP.Service.MotionSensor.UUID : {
                // treat these as EveHome Motion

                // Setup the history service if not already present on the accessory
                let historyService = accessory.getService(HAP.Service.EveHomeHistory);
                if (historyService === undefined) {
                    historyService = accessory.addService(HAP.Service.EveHomeHistory, '', 1);
                }
                if (service.testCharacteristic(HAP.Characteristic.EveSensitivity) === false) {
                    service.addCharacteristic(HAP.Characteristic.EveSensitivity);
                }
                if (service.testCharacteristic(HAP.Characteristic.EveDuration) === false) {
                    service.addCharacteristic(HAP.Characteristic.EveDuration);
                }
                if (service.testCharacteristic(HAP.Characteristic.EveLastActivation) === false) {
                    service.addCharacteristic(HAP.Characteristic.EveLastActivation);
                }

                //service.addCharacteristic(HAP.Characteristic.EveGetConfiguration);
                //service.addCharacteristic(HAP.Characteristic.EveSetConfiguration);

                let tempHistory = this.getHistory(service.UUID, service.subtype);
                let historyreftime = (this.historyData.reset - EPOCH_OFFSET);
                if (tempHistory.length !== 0) {
                    historyreftime = (tempHistory[0].time - EPOCH_OFFSET);
                }

                this.EveHome = {
                    'service': historyService,
                    'linkedservice': service,
                    'type': service.UUID,
                    'sub': service.subtype,
                    'evetype': 'motion',
                    'fields': '1301 1c01',
                    'entry': 0,
                    'count': tempHistory.length,
                    'reftime': historyreftime,
                    'send': 0,
                };

                // Need some internal storage to track Eve Motion configuration from EveHome app
                this.EveMotionPersist = {
                    'duration': (typeof options?.EveMotion_duration === 'number' ? options.EveMotion_duration : 5),  // default 5 seconds
                    'sensitivity': (typeof options?.EveMotion_sensitivity === 'number' ? options.EveMotion_sensivity : HAP.Characteristic.EveSensitivity.HIGH), // default sensitivity
                    'ledmotion': (options?.EveMotion_ledmotion === true), // off
                };

                // Setup initial values and callbacks for charateristics we are using
                service.updateCharacteristic(HAP.Characteristic.EveLastActivation, this.#EveLastEventTime()); // time of last event in seconds since first event
                service.getCharacteristic(HAP.Characteristic.EveLastActivation).onGet(() => {
                    return this.#EveLastEventTime();  // time of last event in seconds since first event
                });

                service.updateCharacteristic(HAP.Characteristic.EveSensitivity, this.EveMotionPersist.sensitivity);
                service.getCharacteristic(HAP.Characteristic.EveSensitivity).onGet(() => {
                    return this.EveMotionPersist.sensitivity;
                });
                service.getCharacteristic(HAP.Characteristic.EveSensitivity).onSet((value) => {
                    this.EveMotionPersist.sensitivity = value;
                });

                service.updateCharacteristic(HAP.Characteristic.EveDuration, this.EveMotionPersist.duration);
                service.getCharacteristic(HAP.Characteristic.EveDuration).onGet(() => {
                    return this.EveMotionPersist.duration;
                });
                service.getCharacteristic(HAP.Characteristic.EveDuration).onSet((value) => {
                    this.EveMotionPersist.duration = value;
                });

                /*service.updateCharacteristic(HAP.Characteristic.EveGetConfiguration, encodeEveData('300100'));
                service.getCharacteristic(HAP.Characteristic.EveGetConfiguration).onGet(() => {
                    let value = util.format(
                        '0002 2500 0302 %s 9b04 %s 8002 ffff 1e02 2500 0c',
                        numberToEveHexString(1144, 4),  // firmware version (build xxxx)
                        numberToEveHexString(Math.floor(Date.now() / 1000), 8), // 'now' time
                    );    // Not sure why 64bit value???

                    console.log('Motion set', value)

                    return encodeEveData(value));
                });
                service.getCharacteristic(HAP.Characteristic.EveSetConfiguration).onSet((value) => {
                    let valHex = decodeEveData(value);
                    let index = 0;
                    while (index < valHex.length) {
                        // first byte is command in this data stream
                        // second byte is size of data for command
                        let command = valHex.substr(index, 2);
                        let size = parseInt(valHex.substr(index + 2, 2), 16) * 2;
                        let data = valHex.substr(index + 4, parseInt(valHex.substr(index + 2, 2), 16) * 2);
                        switch(command) {
                            case '30' : {
                                this.EveMotionPersist.ledmotion = (data === '01' ? true : false);
                                break;
                            }

                            case '80' : {
                                //0000 0400 (mostly) and sometimes 300103 and 80040000 ffff
                                break;
                            }

                            default : {
                                this?.log?.debug && this.log.debug('Unknown Eve Motion command "%s" with data "%s"', command, data);
                                break;
                            }
                        }
                        index += (4 + size);  // Move to next command accounting for header size of 4 bytes
                    }
                }); */
                break;
            }

            case HAP.Service.SmokeSensor.UUID : {
                // treat these as EveHome Smoke

                // Setup the history service if not already present on the accessory
                let historyService = accessory.getService(HAP.Service.EveHomeHistory);
                if (historyService === undefined) {
                    historyService = accessory.addService(HAP.Service.EveHomeHistory, '', 1);
                }
                if (service.testCharacteristic(HAP.Characteristic.EveGetConfiguration) === false) {
                    service.addCharacteristic(HAP.Characteristic.EveGetConfiguration);
                }
                if (service.testCharacteristic(HAP.Characteristic.EveSetConfiguration) === false) {
                    service.addCharacteristic(HAP.Characteristic.EveSetConfiguration);
                }
                if (service.testCharacteristic(HAP.Characteristic.EveDeviceStatus) === false) {
                    service.addCharacteristic(HAP.Characteristic.EveDeviceStatus);
                }

                let tempHistory = this.getHistory(service.UUID, service.subtype);
                let historyreftime = (this.historyData.reset - EPOCH_OFFSET);
                if (tempHistory.length !== 0) {
                    historyreftime = (tempHistory[0].time - EPOCH_OFFSET);
                }

                this.EveHome = {
                    'service': historyService,
                    'linkedservice': service,
                    'type': service.UUID,
                    'sub': service.subtype,
                    'evetype': 'smoke',
                    'fields': '1601 1b02 0f03 2302',
                    'entry': 0,
                    'count': tempHistory.length,
                    'reftime': historyreftime,
                    'send': 0,
                };

                // TODO = work out what the 'signatures' need to be for an Eve Smoke
                // Also, how to make alarm test button active in Eve app and not say 'Eve Smoke is not mounted correctly'

                // Need some internal storage to track Eve Smoke configuration from EveHome app
                this.EveSmokePersist = {
                    'firmware': (typeof options?.EveSmoke_firmware === 'number' ? options.EveSmoke_firmware : 1208), // Firmware version
                    'lastalarmtest': (typeof options?.EveSmoke_lastalarmtest === 'number' ? options.EveSmoke_lastalarmtest : 0), // Time in seconds of alarm test
                    'alarmtest': (options?.EveSmoke_alarmtest === true), // Is alarmtest running
                    'heatstatus': (typeof options?.EveSmoke_heatstatus === 'number' ? options.EveSmoke_heatstatus : 0), // Heat sensor status
                    'statusled': (options?.EveSmoke_statusled === false), // Status LED flash/enabled
                    'smoketestpassed': (options?.EveSmoke_smoketestpassed === false), // Passed smoke test?
                    'heattestpassed': (options?.EveSmoke_heattestpassed === false), // Passed smoke test?
                    'hushedstate': (options.EveSmoke_hushedstate === true), // Alarms muted
                };

                // Setup initial values and callbacks for charateristics we are using
                service.updateCharacteristic(HAP.Characteristic.EveDeviceStatus, this.#EveSmokeGetDetails(options.getcommand, HAP.Characteristic.EveDeviceStatus));
                service.getCharacteristic(HAP.Characteristic.EveDeviceStatus).onGet(() => {
                    return this.#EveSmokeGetDetails(options.getcommand, HAP.Characteristic.EveDeviceStatus);
                });

                service.updateCharacteristic(HAP.Characteristic.EveGetConfiguration, this.#EveSmokeGetDetails(options.getcommand, HAP.Characteristic.EveGetConfiguration));
                service.getCharacteristic(HAP.Characteristic.EveGetConfiguration).onGet(() => {
                    return this.#EveSmokeGetDetails(options.getcommand, HAP.Characteristic.EveGetConfiguration);
                });

                service.getCharacteristic(HAP.Characteristic.EveSetConfiguration).onSet((value) => {
                    // Loop through set commands passed to us
                    let processedData = {};
                    let valHex = decodeEveData(value);
                    let index = 0;
                    while (index < valHex.length) {
                        // first byte is command in this data stream
                        // second byte is size of data for command
                        let command = valHex.substr(index, 2);
                        let size = parseInt(valHex.substr(index + 2, 2), 16) * 2;
                        let data = valHex.substr(index + 4, parseInt(valHex.substr(index + 2, 2), 16) * 2);
                        switch(command) {
                            case '40' : {
                                let subCommand = EveHexStringToNumber(data.substr(0, 2));
                                if (subCommand === 0x02) {
                                    // Alarm test start/stop
                                    this.EveSmokePersist.alarmtest = (data === '0201') ? true : false;
                                    processedData.alarmtest = this.EveSmokePersist.alarmtest;
                                }
                                if (subCommand === 0x05) {
                                    // Flash status Led on/off
                                    this.EveSmokePersist.statusled = (data === '0501') ? true : false;
                                    processedData.statusled = this.EveSmokePersist.statusled;
                                }
                                if (subCommand !== 0x02 && subCommand !== 0x05) {
                                    this?.log?.debug && this.log.debug('Unknown Eve Smoke command "%s" with data "%s"', command, data);
                                }
                                break;
                            }

                            default : {
                                this?.log?.debug && this.log.debug('Unknown Eve Smoke command "%s" with data "%s"', command, data);
                                break;
                            }
                        }
                        index += (4 + size);  // Move to next command accounting for header size of 4 bytes
                    }

                    // Send complete processed command data if configured to our callback
                    if (typeof options?.setcommand === 'function' && Object.keys(processedData).length !== 0) {
                        options.setcommand(processedData);
                    }
                });
                break;
            }

            case HAP.Service.Valve.UUID :
            case HAP.Service.IrrigationSystem.UUID : {
                // treat an irrigation system as EveHome Aqua
                // Under this, any valve history will be presented under this. We don't log our History under irrigation service ID at all

                // TODO - see if we can add history per valve service under the irrigation system????. History service per valve???

                // Setup the history service if not already present on the accessory
                let historyService = accessory.getService(HAP.Service.EveHomeHistory);
                if (historyService === undefined) {
                    historyService = accessory.addService(HAP.Service.EveHomeHistory, '', 1);
                }
                if (service.testCharacteristic(HAP.Characteristic.EveGetConfiguration) === false) {
                    service.addCharacteristic(HAP.Characteristic.EveGetConfiguration);
                }
                if (service.testCharacteristic(HAP.Characteristic.EveSetConfiguration) === false) {
                    service.addCharacteristic(HAP.Characteristic.EveSetConfiguration);
                }
                if (service.testCharacteristic(HAP.Characteristic.LockPhysicalControls) === false) {
                    // Allows childlock toggle to be displayed in Eve App
                    service.addCharacteristic(HAP.Characteristic.LockPhysicalControls);
                }

                let tempHistory = this.getHistory(HAP.Service.Valve.UUID, (service.UUID === HAP.Service.IrrigationSystem.UUID ? null : service.subtype));
                let historyreftime = (this.historyData.reset - EPOCH_OFFSET);
                if (tempHistory.length !== 0) {
                    historyreftime = (tempHistory[0].time - EPOCH_OFFSET);
                }

                this.EveHome = {
                    'service': historyService,
                    'linkedservice': service,
                    'type': HAP.Service.Valve.UUID,
                    'sub': (service.UUID === HAP.Service.IrrigationSystem.UUID ? null : service.subtype),
                    'evetype': 'aqua',
                    'fields': '1f01 2a08 2302',
                    'entry': 0,
                    'count': tempHistory.length,
                    'reftime': historyreftime,
                    'send': 0,
                };

                // Need some internal storage to track Eve Aqua configuration from EveHome app
                this.EveAquaPersist = {
                    'firmware': (typeof options?.EveAqua_firmware === 'number' ? options.EveAqua_firmware : 1208), // Firmware version
                    'flowrate': (typeof options?.EveAqua_flowrate === 'number' ? options.EveAqua_flowrate : 18), // 18 L/Min default
                    'latitude': (typeof options?.EveAqua_latitude === 'number' ? options.EveAqua_latitude : 0.0),  // Latitude
                    'longitude': (typeof options?.EveAqua_longitude === 'number' ? options.EveAqua_longitude : 0.0),  // Longitude
                    'utcoffset': (typeof options?.EveAqua_utcoffset === 'number' ? options.EveAqua_utcoffset : (new Date().getTimezoneOffset() * -60)),  // UTC offset in seconds
                    'enableschedule': (options.EveAqua_enableschedule === true), // Schedules on/off
                    'pause': (typeof options?.EveAqua_pause === 'number' ? options.EveAqua_pause : 0),  // Day pause
                    'programs': (typeof options?.EveAqua_programs === 'object' ? options.EveAqua_programs : []),    // Schedules
                };

                // Setup initial values and callbacks for charateristics we are using
                service.updateCharacteristic(HAP.Characteristic.EveGetConfiguration, this.#EveAquaGetDetails(options.getcommand));
                service.getCharacteristic(HAP.Characteristic.EveGetConfiguration).onGet(() => {
                    return this.#EveAquaGetDetails(options.getcommand);
                });

                service.getCharacteristic(HAP.Characteristic.EveSetConfiguration).onSet((value) => {
                    // Loop through set commands passed to us
                    let programs = [];
                    let processedData = {};
                    let valHex = decodeEveData(value);
                    let index = 0;
                    while (index < valHex.length) {
                        // first byte is command in this data stream
                        // second byte is size of data for command
                        let command = valHex.substr(index, 2);
                        let size = parseInt(valHex.substr(index + 2, 2), 16) * 2;
                        let data = valHex.substr(index + 4, parseInt(valHex.substr(index + 2, 2), 16) * 2);
                        switch(command) {
                            case '2e' : {
                                // flow rate in L/Minute
                                this.EveAquaPersist.flowrate = Number(((EveHexStringToNumber(data) * 60) / 1000).toFixed(1));
                                processedData.flowrate = this.EveAquaPersist.flowrate;
                                break;
                            }

                            case '2f' : {
                                // reset timestamp in seconds since EPOCH
                                this.EveAquaPersist.timestamp = (EPOCH_OFFSET + EveHexStringToNumber(data));
                                processedData.timestamp = this.EveAquaPersist.timestamp;
                                break;
                            }

                            case '44' : {
                                // Schedules on/off and Timezone/location information
                                let subCommand = EveHexStringToNumber(data.substr(2, 4));
                                this.EveAquaPersist.enableschedule = (subCommand & 0x01) === 0x01;   // Bit 1 is schedule status on/off
                                if ((subCommand & 0x10) === 0x10) {
                                    this.EveAquaPersist.utcoffset = EveHexStringToNumber(data.substr(10, 8)) * 60;   // Bit 5 is UTC offset in seconds
                                }
                                if ((subCommand & 0x04) === 0x04) {
                                    this.EveAquaPersist.latitude = EveHexStringToNumber(data.substr(18, 8), 5);   // Bit 4 is lat/long information
                                }
                                if ((subCommand & 0x04) === 0x04) {
                                    this.EveAquaPersist.longitude = EveHexStringToNumber(data.substr(26, 8), 5);  // Bit 4 is lat/long information
                                }
                                if ((subCommand & 0x02) === 0x02) {
                                    // If bit 2 is set, indicates just a schedule on/off command
                                    processedData.enabled = this.EveAquaPersist.enableschedule;
                                }
                                if ((subCommand & 0x02) !== 0x02) {
                                    // If bit 2 is not set, this command includes Timezone/location information
                                    processedData.utcoffset = this.EveAquaPersist.utcoffset;
                                    processedData.latitude = this.EveAquaPersist.latitude;
                                    processedData.longitude = this.EveAquaPersist.longitude;
                                }
                                break;
                            }

                            case '45' : {
                                // Eve App Scheduling Programs
                                //let programcount = EveHexStringToNumber(data.substr(2, 2));   // Number of defined programs
                                //let unknown = EveHexStringToNumber(data.substr(4, 6));   // Unknown data for 6 bytes

                                let index2 = 14;    // Program schedules start at offset 14 in data
                                let programs = [];
                                while (index2 < data.length) {
                                    let scheduleSize = parseInt(data.substr(index2 + 2, 2), 16) * 8;
                                    let schedule = data.substring(index2 + 4, index2 + 4 + scheduleSize);

                                    if (schedule !== '') {
                                        let times = [];
                                        for (let index3 = 0; index3 < schedule.length / 8; index3++) {
                                            // schedules appear to be a 32bit word
                                            // after swapping 16bit words
                                            // 1st 16bits = end time
                                            // 2nd 16bits = start time
                                            // starttime decode
                                            // bit 1-5 specific time or sunrise/sunset 05 = time, 07 = sunrise/sunset
                                            // if sunrise/sunset
                                            //      bit 6, sunrise = 1, sunset = 0
                                            //      bit 7, before = 1, after = 0
                                            //      bit 8 - 16 - minutes for sunrise/sunset
                                            // if time
                                            //      bit 6 - 16 - minutes from 00:00
                                            //
                                            // endtime decode
                                            // bit 1-5 specific time or sunrise/sunset 01 = time, 03 = sunrise/sunset
                                            // if sunrise/sunset
                                            //      bit 6, sunrise = 1, sunset = 0
                                            //      bit 7, before = 1, after = 0
                                            //      bit 8 - 16 - minutes for sunrise/sunset
                                            // if time
                                            //      bit 6 - 16 - minutes from 00:00
                                            // decode start time
                                            let start = parseInt(schedule.substring((index3 * 8), (index3 * 8) + 4).match(/[a-fA-F0-9]{2}/g).reverse().join(''), 16);
                                            // let start_min = null;
                                            //let start_hr = null;
                                            let start_offset = null;
                                            let start_sunrise = null;
                                            if ((start & 0x1f) === 5) {
                                                // specific time
                                                //start_min = (start >>> 5) % 60;   // Start minute
                                                //start_hr = ((start >>> 5) - start_min) / 60;    // Start hour
                                                start_offset = ((start >>> 5) * 60);    // Seconds since 00:00
                                            } else if ((start & 0x1f) === 7) {
                                                // sunrise/sunset
                                                start_sunrise = ((start >>> 5) & 0x01);    // 1 = sunrise, 0 = sunset
                                                start_offset = ((start >>> 6) & 0x01 ? ~((start >>> 7) * 60) + 1 : (start >>> 7) * 60);   // offset from sunrise/sunset (plus/minus value)
                                            }

                                            // decode end time
                                            let end = parseInt(schedule.substring((index3 * 8) + 4, (index3 * 8) + 8).match(/[a-fA-F0-9]{2}/g).reverse().join(''), 16);
                                            //let end_min = null;
                                            //let end_hr = null;
                                            let end_offset = null;
                                            //let end_sunrise = null;
                                            if ((end & 0x1f) === 1) {
                                                // specific time
                                                //end_min = (end >>> 5) % 60;   // End minute
                                                //end_hr = ((end >>> 5) - end_min) / 60;    // End hour
                                                end_offset = ((end >>> 5) * 60);    // Seconds since 00:00
                                            } else if ((end & 0x1f) === 3) {
                                                //end_sunrise = ((end >>> 5) & 0x01);    // 1 = sunrise, 0 = sunset
                                                end_offset = ((end >>> 6) & 0x01 ? ~((end >>> 7) * 60) + 1 : (end >>> 7) * 60);   // offset from sunrise/sunset (plus/minus value)
                                            }
                                            times.push({
                                                'start' : (start_sunrise === null ? start_offset : (start_sunrise ? 'sunrise' : 'sunset')),
                                                'duration' : (end_offset - start_offset),
                                                'offset': start_offset,
                                            });
                                        }
                                        programs.push({'id': (programs.length + 1), 'days': [], 'schedule': times});
                                    }
                                    index2 = index2 + 4 + scheduleSize; // Move to next program
                                }
                                break;
                            }

                            case '46' : {
                                // Eve App active days across programs
                                //let daynumber = (EveHexStringToNumber(data.substr(8, 6)) >>> 4);

                                // bit masks for active days mapped to programm id
                                /* let mon = (daynumber & 0x7);
                                let tue = ((daynumber >>> 3) & 0x7)
                                let wed = ((daynumber >>> 6) & 0x7)
                                let thu = ((daynumber >>> 9) & 0x7)
                                let fri = ((daynumber >>> 12) & 0x7)
                                let sat = ((daynumber >>> 15) & 0x7)
                                let sun = ((daynumber >>> 18) & 0x7) */
                                //let unknown = EveHexStringToNumber(data.substr(0, 6));   // Unknown data for first 6 bytes
                                let daysbitmask = (EveHexStringToNumber(data.substr(8, 6)) >>> 4);
                                programs.forEach(program => {
                                    for (let index2 = 0; index2 < DAYSOFWEEK.length; index2++) {
                                        if (((daysbitmask >>> (index2 * 3)) & 0x7) === program.id) {
                                            program.days.push(DAYSOFWEEK[index2]);
                                        }
                                    }
                                });

                                processedData.programs = programs;
                                break;
                            }

                            case '47' : {
                                // Eve App DST information
                                this.EveAquaPersist.command47 = command + valHex.substr(index + 2, 2) + data;
                                break;
                            }

                            case '4b' : {
                                // Eve App suspension scene triggered from HomeKit
                                this.EveAquaPersist.pause = (EveHexStringToNumber(data.substr(0, 8)) / 1440) + 1; // 1440 mins in a day. Zero based day, so we add one
                                processedData.pause = this.EveAquaPersist.pause;
                                break;
                            }

                            case 'b1' : {
                                // Child lock on/off. Seems data packet is always same (0100), so inspect 'HAP.Characteristic.LockPhysicalControls)' for actual status
                                this.EveAquaPersist.childlock = (service.getCharacteristic(HAP.Characteristic.LockPhysicalControls).value === HAP.Characteristic.CONTROL_LOCK_ENABLED ? true : false);
                                processedData.childlock = this.EveAquaPersist.childlock;
                                break;
                            }

                            default : {
                                this?.log?.debug && this.log.debug('Unknown Eve Aqua command "%s" with data "%s"', command, data);
                                break;
                            }
                        }
                        index += (4 + size);  // Move to next command accounting for header size of 4 bytes
                    }

                    // Send complete processed command data if configured to our callback
                    if (typeof options?.setcommand === 'function' && Object.keys(processedData).length !== 0) {
                        options.setcommand(processedData);
                    }
                });
                break;
            }

            case HAP.Service.Outlet.UUID : {
                // treat these as EveHome energy
                // TODO - schedules

                // Setup the history service if not already present on the accessory
                let historyService = accessory.getService(HAP.Service.EveHomeHistory);
                if (historyService === undefined) {
                    historyService = accessory.addService(HAP.Service.EveHomeHistory, '', 1);
                }
                if (service.testCharacteristic(HAP.Characteristic.EveFirmware) === false) {
                    service.addCharacteristic(HAP.Characteristic.EveFirmware);
                }
                if (service.testCharacteristic(HAP.Characteristic.EveElectricalVoltage) === false) {
                    service.addCharacteristic(HAP.Characteristic.EveElectricalVoltage);
                }
                if (service.testCharacteristic(HAP.Characteristic.EveElectricalCurrent) === false) {
                    service.addCharacteristic(HAP.Characteristic.EveElectricalCurrent);
                }
                if (service.testCharacteristic(HAP.Characteristic.EveElectricalWattage) === false) {
                    service.addCharacteristic(HAP.Characteristic.EveElectricalWattage);
                }
                if (service.testCharacteristic(HAP.Characteristic.EveTotalConsumption) === false) {
                    service.addCharacteristic(HAP.Characteristic.EveSetConfEveTotalConsumptioniguration);
                }

                let tempHistory = this.getHistory(service.UUID, service.subtype);
                let historyreftime = (this.historyData.reset - EPOCH_OFFSET);
                if (tempHistory.length !== 0) {
                    historyreftime = (tempHistory[0].time - EPOCH_OFFSET);
                }

                this.EveHome = {
                    'service': historyService,
                    'linkedservice': service,
                    'type': service.UUID,
                    'sub': service.subtype,
                    'evetype': 'energy',
                    'fields': '0702 0e01',
                    'entry': 0,
                    'count': tempHistory.length,
                    'reftime': historyreftime,
                    'send': 0,
                };

                // Setup initial values and callbacks for charateristics we are using
                service.updateCharacteristic(HAP.Characteristic.EveFirmware, encodeEveData(util.format('29 %s be', numberToEveHexString(807, 4))));  // firmware version (build xxxx)));

                service.updateCharacteristic(HAP.Characteristic.EveElectricalCurrent, this.#EveEnergyGetDetails(options.getcommand, HAP.Characteristic.EveElectricalCurrent));
                service.getCharacteristic(HAP.Characteristic.EveElectricalCurrent).onGet(() => {
                    return this.#EveEnergyGetDetails(options.getcommand, HAP.Characteristic.EveElectricalCurrent);
                });

                service.updateCharacteristic(HAP.Characteristic.EveElectricalVoltage, this.#EveEnergyGetDetails(options.getcommand, HAP.Characteristic.EveElectricalVoltage));
                service.getCharacteristic(HAP.Characteristic.EveElectricalVoltage).onGet(() => {
                    return this.#EveEnergyGetDetails(options.getcommand, HAP.Characteristic.EveElectricalVoltage);
                });

                service.updateCharacteristic(HAP.Characteristic.EveElectricalWattage, this.#EveEnergyGetDetails(options.getcommand, HAP.Characteristic.EveElectricalWattage));
                service.getCharacteristic(HAP.Characteristic.EveElectricalWattage).onGet(() => {
                    return this.#EveEnergyGetDetails(options.getcommand, HAP.Characteristic.EveElectricalWattage);
                });
                break;
            }


            case HAP.Service.LeakSensor.UUID : {
                // treat these as EveHome Water Guard

                // Setup the history service if not already present on the accessory
                let historyService = accessory.getService(HAP.Service.EveHomeHistory);
                if (historyService === undefined) {
                    historyService = accessory.addService(HAP.Service.EveHomeHistory, '', 1);
                }
                if (service.testCharacteristic(HAP.Characteristic.EveGetConfiguration) === false) {
                    service.addCharacteristic(HAP.Characteristic.EveGetConfiguration);
                }
                if (service.testCharacteristic(HAP.Characteristic.EveSetConfiguration) === false) {
                    service.addCharacteristic(HAP.Characteristic.EveSetConfiguration);
                }
                if (service.testCharacteristic(HAP.Characteristic.StatusFault) === false) {
                    service.addCharacteristic(HAP.Characteristic.StatusFault);
                }

                let tempHistory = this.getHistory(service.UUID, service.subtype);
                let historyreftime = (this.historyData.reset - EPOCH_OFFSET);
                if (tempHistory.length !== 0) {
                    historyreftime = (tempHistory[0].time - EPOCH_OFFSET);
                }

                // <---- Still need to determine signature fields
                this.EveHome = {
                    'service': historyService,
                    'linkedservice': service,
                    'type': service.UUID,
                    'sub': service.subtype,
                    'evetype': 'waterguard',
                    'fields': 'xxxx',
                    'entry': 0,
                    'count': tempHistory.length,
                    'reftime': historyreftime,
                    'send': 0,
                };

                // Need some internal storage to track Eve Water Guard configuration from EveHome app
                this.EveWaterGuardPersist = {
                    'firmware': (typeof options?.EveWaterGuard_firmware === 'number' ? options.EveWaterGuard_firmware : 2866), // Firmware version
                    'lastalarmtest': (typeof options?.EveWaterGuard_lastalarmtest === 'number' ? options.EveWaterGuard_lastalarmtest : 0), // Time in seconds of alarm test
                    'muted': (options?.EveWaterGuard_muted === true),   // Leak alarms are not muted
                };

                // Setup initial values and callbacks for charateristics we are using
                service.updateCharacteristic(HAP.Characteristic.EveGetConfiguration, this.#EveWaterGuardGetDetails(options.getcommand));
                service.getCharacteristic(HAP.Characteristic.EveGetConfiguration).onGet(() => {
                    return this.#EveWaterGuardGetDetails(options.getcommand);
                });

                service.getCharacteristic(HAP.Characteristic.EveSetConfiguration).onSet((value) => {
                    let valHex = decodeEveData(value);
                    let index = 0;
                    while (index < valHex.length) {
                        // first byte is command in this data stream
                        // second byte is size of data for command
                        let command = valHex.substr(index, 2);
                        let size = parseInt(valHex.substr(index + 2, 2), 16) * 2;
                        let data = valHex.substr(index + 4, parseInt(valHex.substr(index + 2, 2), 16) * 2);

                        //console.log(command, data);
                        switch(command) {
                            case '4d' : {
                                // Alarm test
                                // b4 - start
                                // 00 - finished
                                break;
                            }

                            case '4e' : {
                                // Mute alarm
                                // 00 - unmute alarm
                                // 01 - mute alarm
                                // 03 - alarm test
                                if (data === '03') {
                                    // Simulate a leak test
                                    service.updateCharacteristic(HAP.Characteristic.LeakDetected, HAP.Characteristic.LeakDetected.LEAK_DETECTED);
                                    this.EveWaterGuardPersist.lastalarmtest = Math.floor(Date.now() / 1000);    // Now time for last test

                                    setTimeout(() => {
                                        // Clear our simulated leak test after 5 seconds
                                        service.updateCharacteristic(HAP.Characteristic.LeakDetected, HAP.Characteristic.LeakDetected.LEAK_NOT_DETECTED);
                                    }, 5000);
                                }
                                if (data === '00' || data === '01') {
                                    this.EveWaterGuardPersist.muted = (data === '01' ? true : false);
                                }
                                break;
                            }

                            default : {
                                this?.log?.debug && this.log.debug('Unknown Eve Water Guard command "%s" with data "%s"', command, data);
                                break;
                            }
                        }
                        index += (4 + size);  // Move to next command accounting for header size of 4 bytes
                    }
                });
                break;
            }
        }

        // Setup callbacks if our service successfully created
        if (typeof this?.EveHome?.service === 'object') {
            this.EveHome.service.getCharacteristic(HAP.Characteristic.EveResetTotal).onGet(() => {
                // time since history reset
                return (this.historyData.reset - EPOCH_OFFSET);
            });
            this.EveHome.service.getCharacteristic(HAP.Characteristic.EveHistoryStatus).onGet(() => {
                return this.#EveHistoryStatus();
            });
            this.EveHome.service.getCharacteristic(HAP.Characteristic.EveHistoryEntries).onGet(() => {
                return this.#EveHistoryEntries();
            });
            this.EveHome.service.getCharacteristic(HAP.Characteristic.EveHistoryRequest).onSet((value) => {
                this.#EveHistoryRequest(value);
            });
            this.EveHome.service.getCharacteristic(HAP.Characteristic.EveSetTime).onSet((value) => {
                this.#EveSetTime(value);
            });

            return this.EveHome.service;    // Return service handle for our EveHome accessory service
        }
    }

    updateEveHome(service, getcommand) {
        if (typeof this?.EveHome?.service !== 'object' || typeof getcommand !== 'function') {
            return;
        }

        switch (service.UUID) {
            case HAP.Service.SmokeSensor.UUID : {
                service.updateCharacteristic(HAP.Characteristic.EveDeviceStatus, this.#EveSmokeGetDetails(getcommand, HAP.Characteristic.EveDeviceStatus));
                service.updateCharacteristic(HAP.Characteristic.EveGetConfiguration, this.#EveSmokeGetDetails(getcommand, HAP.Characteristic.EveGetConfiguration));
                break;
            }

            case HAP.Service.HeaterCooler.UUID :
            case HAP.Service.Thermostat.UUID : {
                service.updateCharacteristic(HAP.Characteristic.EveProgramCommand, this.#EveThermoGetDetails(getcommand));
                break;
            }

            case HAP.Service.Valve.UUID :
            case HAP.Service.IrrigationSystem.UUID : {
                service.updateCharacteristic(HAP.Characteristic.EveGetConfiguration, this.#EveAquaGetDetails(getcommand));
                break;
            }

            case HAP.Service.Outlet.UUID : {
                service.updateCharacteristic(HAP.Characteristic.EveElectricalWattage, this.#EveEnergyGetDetails(getcommand, HAP.Characteristic.EveElectricalWattage));
                service.updateCharacteristic(HAP.Characteristic.EveElectricalVoltage, this.#EveEnergyGetDetails(getcommand, HAP.Characteristic.EveElectricalVoltage));
                service.updateCharacteristic(HAP.Characteristic.EveElectricalCurrent, this.#EveEnergyGetDetails(getcommand, HAP.Characteristic.EveElectricalCurrent));
                break;
            }
        }
    }

    #EveLastEventTime() {
        // calculate time in seconds since first event to last event. If no history we'll use the current time as the last event time
        let historyEntry = this.lastHistory(this.EveHome.type, this.EveHome.sub);
        let lastTime = Math.floor(Date.now() / 1000) - (this.EveHome.reftime + EPOCH_OFFSET);
        if (historyEntry && Object.keys(historyEntry).length !== 0) {
            lastTime -= (Math.floor(Date.now() / 1000) - historyEntry.time);
        }
        return lastTime;
    }

    #EveThermoGetDetails(getOptions) {
        // returns an encoded value formatted for an Eve Thermo device
        //
        // TODO - before enabling below need to workout:
        //          - mode graph to show
        //          - temperature unit setting
        //          - thermo 2020??
        //
        // commands
        // 11 - valve protection on/off - TODO
        // 12 - temp offset
        // 13 - schedules enabled/disabled
        // 16 - Window/Door open status
        //          100000 - open
        //          000000 - close
        // 14 - installation status
        //          c0,c8 = ok
        //          c1,c6,c9 = in-progress
        //          c2,c3,c4,c5 = error on removal
        //          c7 = not attached
        // 19 - vacation mode
        //          00ff - off
        //          01 + 'away temp' - enabled with vacation temp
        // f4 - temperatures
        // fa - programs for week
        // fc - date/time (mmhhDDMMYY)
        // 1a - default day program??

        if (typeof getOptions === 'function') {
            // Fill in details we might want to be dynamic
            this.EveThermoPersist = getOptions(this.EveThermoPersist);
        }

        // Encode current date/time
        //let tempDateTime = numberToEveHexString(new Date(Date.now()).getMinutes(), 2) + numberToEveHexString(new Date(Date.now()).getHours(), 2) + numberToEveHexString(new Date(Date.now()).getDate(), 2) + numberToEveHexString(new Date(Date.now()).getMonth() + 1, 2) + numberToEveHexString(parseInt(new Date(Date.now()).getFullYear().toString().substr(-2)), 2);

        // Encode program schedule and temperatures
        // f4 = temps
        // fa = schedule
        const EMPTYSCHEDULE = 'ffffffffffffffff';
        let encodedSchedule = [EMPTYSCHEDULE, EMPTYSCHEDULE, EMPTYSCHEDULE, EMPTYSCHEDULE, EMPTYSCHEDULE, EMPTYSCHEDULE, EMPTYSCHEDULE];
        let encodedTemperatures = '0000';
        if (typeof this.EveThermoPersist.programs === 'object') {
            let tempTemperatures = [];
            Object.values(this.EveThermoPersist.programs).forEach((days)=> {
                let temp = '';
                days.schedule.forEach(time => {
                    temp = temp + numberToEveHexString(Math.round(time.start / 600), 2) + numberToEveHexString(Math.round((time.start + time.duration) / 600), 2);
                    tempTemperatures.push(time.ecotemp, time.comforttemp);
                });
                encodedSchedule[DAYSOFWEEK.indexOf(days.days.toLowerCase())] = temp.substring(0, EMPTYSCHEDULE.length) + EMPTYSCHEDULE.substring(temp.length, EMPTYSCHEDULE.length);
            });
            let ecoTemp = tempTemperatures.length === 0 ? 0 : Math.min(...tempTemperatures);
            let comfortTemp = tempTemperatures.length === 0 ? 0 : Math.max(...tempTemperatures);
            encodedTemperatures = numberToEveHexString(Math.round(ecoTemp * 2), 2) + numberToEveHexString(Math.round(comfortTemp * 2), 2);
        }

        let value = util.format(
            '12%s 13%s 14%s 19%s f40000%s fa%s',
            numberToEveHexString(this.EveThermoPersist.tempoffset * 10, 2),
            this.EveThermoPersist.enableschedule === true ? '01' : '00',
            this.EveThermoPersist.attached = (this.EveThermoPersist.attached === true ? 'c0' : 'c7'),
            this.EveThermoPersist.vacation === true ? '01' + numberToEveHexString(this.EveThermoPersist.vacationtemp * 2, 2) : '00ff', // away status and temp
            encodedTemperatures,
            encodedSchedule[0] + encodedSchedule[1] + encodedSchedule[2] + encodedSchedule[3] + encodedSchedule[4] + encodedSchedule[5] + encodedSchedule[6],
        );

        return encodeEveData(value);
    }

    #EveAquaGetDetails(getOptions) {
        // returns an encoded value formatted for an Eve Aqua device for water usage and last water time
        if (typeof getOptions === 'function') {
            // Fill in details we might want to be dynamic
            this.EveAquaPersist = getOptions(this.EveAquaPersist);
        }

        if (Array.isArray(this.EveAquaPersist.programs) === false) {
            // Ensure any program information is an array
            this.EveAquaPersist.programs = [];
        }

        let tempHistory = this.getHistory(this.EveHome.type, this.EveHome.sub); // get flattened history array for easier processing

        // Calculate total water usage over history period
        let totalWater = 0;
        tempHistory.forEach(historyEntry => {
            if (historyEntry.status === 0) {
                // add to total water usage if we have a valve closed event
                totalWater += parseFloat(historyEntry.water);
            }
        });

        // Encode program schedule
        // 45 = schedules
        // 46 = days of weeks for schedule;
        const EMPTYSCHEDULE = '0800';
        let encodedSchedule = '';
        let daysbitmask = 0;
        let temp45Command = '';
        let temp46Command = '';

        this.EveAquaPersist.programs.forEach((program) => {
            let tempEncodedSchedule = '';
            program.schedule.forEach((schedule) => {
                // Encode absolute time (ie: not sunrise/sunset one)
                if (typeof schedule.start === 'number') {
                    tempEncodedSchedule = tempEncodedSchedule + numberToEveHexString(((schedule.start / 60) << 5) + 0x05, 4);
                    tempEncodedSchedule = tempEncodedSchedule + numberToEveHexString((((schedule.start + schedule.duration) / 60) << 5) + 0x01, 4);
                }
                if (typeof schedule.start === 'string' && schedule.start === 'sunrise') {
                    if (schedule.offset < 0) {
                        tempEncodedSchedule = tempEncodedSchedule + numberToEveHexString(((Math.abs(schedule.offset) / 60) << 7) + 0x67, 4);
                        tempEncodedSchedule = tempEncodedSchedule + numberToEveHexString((((Math.abs(schedule.offset) + schedule.duration) / 60) << 7) + 0x63, 4);
                    }
                    if (schedule.offset >= 0) {
                        tempEncodedSchedule = tempEncodedSchedule + numberToEveHexString(((schedule.offset / 60) << 7) + 0x27, 4);
                        tempEncodedSchedule = tempEncodedSchedule + numberToEveHexString((((schedule.offset + schedule.duration) / 60) << 7) + 0x23, 4);
                    }
                }
                if (typeof schedule.start === 'string' && schedule.start === 'sunset') {
                    if (schedule.offset < 0) {
                        tempEncodedSchedule = tempEncodedSchedule + numberToEveHexString(((Math.abs(schedule.offset) / 60) << 7) + 0x47, 4);
                        tempEncodedSchedule = tempEncodedSchedule + numberToEveHexString((((Math.abs(schedule.offset) + schedule.duration) / 60) << 7) + 0x43, 4);
                    }
                    if (schedule.offset >= 0) {
                        tempEncodedSchedule = tempEncodedSchedule + numberToEveHexString(((schedule.offset / 60) << 7) + 0x07, 4);
                        tempEncodedSchedule = tempEncodedSchedule + numberToEveHexString((((schedule.offset + schedule.duration) / 60) << 7) + 0x03, 4);
                    }
                }
            });
            encodedSchedule = encodedSchedule + numberToEveHexString((tempEncodedSchedule.length / 8) < 2 ? 10 : 11, 2) + numberToEveHexString(tempEncodedSchedule.length / 8, 2) + tempEncodedSchedule;

            // Encode days for this program
            // Program ID is set in 3bit repeating sections
            // sunsatfrithuwedtuemon
            program.days.forEach((day) => {
                daysbitmask = daysbitmask + (program.id << (DAYSOFWEEK.indexOf(day) * 3));
            });
        });

        // Build the encoded schedules command to send back to Eve
        temp45Command = '05' + numberToEveHexString(this.EveAquaPersist.programs.length + 1, 2) + '000000' + EMPTYSCHEDULE + encodedSchedule;
        temp45Command = '45' + numberToEveHexString(temp45Command.length / 2, 2) + temp45Command;

        // Build the encoded days command to send back to Eve
        // 00000 appears to always be 1b202c??
        temp46Command = '05' + '000000' + numberToEveHexString((daysbitmask << 4) + 0x0f, 6);
        temp46Command = temp46Command.padEnd((daysbitmask === 0 ? 18 : 168), '0');   // Pad the command out to Eve's lengths
        temp46Command = '46' + numberToEveHexString(temp46Command.length / 2, 2) + temp46Command;

        let value = util.format(
            '0002 2300 0302 %s d004 %s 9b04 %s 2f0e %s 2e02 %s 441105 %s%s%s%s %s %s %s 0000000000000000 1e02 2300 0c',
            numberToEveHexString(this.EveAquaPersist.firmware, 4),  // firmware version (build xxxx)
            numberToEveHexString(tempHistory.length !== 0 ? tempHistory[tempHistory.length - 1].time : 0, 8),  // time of last event, 0 if never watered
            numberToEveHexString(Math.floor(Date.now() / 1000), 8), // 'now' time
            numberToEveHexString(Math.floor(totalWater * 1000), 20), // total water usage in ml (64bit value)
            numberToEveHexString(Math.floor((this.EveAquaPersist.flowrate * 1000) / 60), 4), // water flow rate (16bit value)
            numberToEveHexString(this.EveAquaPersist.enableschedule === true ? parseInt('10111', 2) : parseInt('10110', 2), 8),
            numberToEveHexString(Math.floor(this.EveAquaPersist.utcoffset / 60), 8),
            numberToEveHexString(this.EveAquaPersist.latitude, 8, 5),   // For lat/long, we need 5 digits of precession
            numberToEveHexString(this.EveAquaPersist.longitude, 8, 5),  // For lat/long, we need 5 digits of precession
            (this.EveAquaPersist.pause !== 0 ? '4b04' + numberToEveHexString((this.EveAquaPersist.pause - 1) * 1440, 8) : ''),
            temp45Command,
            temp46Command);

        return encodeEveData(value);
    }

    #EveEnergyGetDetails(getOptions, returnForCharacteristic) {
        let energyDetails = {};
        let returnValue = null;

        if (typeof getOptions === 'function') {
            // Fill in details we might want to be dynamic
            energyDetails = getOptions(energyDetails);
        }

        if (returnForCharacteristic.UUID === HAP.Characteristic.EveElectricalWattage.UUID && typeof energyDetails?.watts === 'number') {
            returnValue = energyDetails.watts;
        }
        if (returnForCharacteristic.UUID === HAP.Characteristic.EveElectricalVoltage.UUID && typeof energyDetails?.volts === 'number') {
            returnValue = energyDetails.volts;
        }
        if (returnForCharacteristic.UUID === HAP.Characteristic.EveElectricalCurrent.UUID && typeof energyDetails?.amps === 'number') {
            returnValue = energyDetails.amps;
        }

        return returnValue;
    }

    #EveSmokeGetDetails(getOptions, returnForCharacteristic) {
        // returns an encoded value formatted for an Eve Smoke device
        let returnValue = null;

        if (typeof getOptions === 'function') {
            // Fill in details we might want to be dynamic
            this.EveSmokePersist = getOptions(this.EveSmokePersist);
        }

        if (returnForCharacteristic.UUID === HAP.Characteristic.EveGetConfiguration.UUID) {
            let value = util.format(
                '0002 1800 0302 %s 9b04 %s 8608 %s 1e02 1800 0c',
                numberToEveHexString(this.EveSmokePersist.firmware, 4),  // firmware version (build xxxx)
                numberToEveHexString(Math.floor(Date.now() / 1000), 8), // 'now' time
                numberToEveHexString(this.EveSmokePersist.lastalarmtest, 8));    // Not sure why 64bit value???
            returnValue = encodeEveData(value);
        }

        if (returnForCharacteristic.UUID === HAP.Characteristic.EveDeviceStatus.UUID) {
            // Status bits
            //  0 = Smoked Detected
            //  1 = Heat Detected
            //  2 = Alarm test active
            //  5 = Smoke sensor error
            //  6 = Heat sensor error
            //  7 = Sensor error??
            //  9 = Smoke chamber error
            // 14 = Smoke sensor deactivated
            // 15 = flash status led (on)
            // 24 & 25 = alarms paused
            // 25 = alarm muted
            let value = 0x00000000;
            if (this.EveHome.linkedservice.getCharacteristic(HAP.Characteristic.SmokeDetected).value === HAP.Characteristic.SmokeDetected.SMOKE_DETECTED) {
                value |= (1 << 0);  // 1st bit, smoke detected
            }
            if (this.EveSmokePersist.heatstatus !== 0) {
                value |= (1 << 1);    // 2th bit - heat detected
            }
            if (this.EveSmokePersist.alarmtest === true) {
                value |= (1 << 2);    // 4th bit - alarm test running
            }
            if (this.EveSmokePersist.smoketestpassed === false) {
                value |= (1 << 5);   // 5th bit - smoke test OK
            }
            if (this.EveSmokePersist.heattestpassed === false) {
                value |= (1 << 6);   // 6th bit - heat test OK
            }
            if (this.EveSmokePersist.smoketestpassed === false) {
                value |= (1 << 9);   // 9th bit - smoke test OK
            }
            if (this.EveSmokePersist.statusled === true) {
                value |= (1 << 15);   // 15th bit - flash status led
            }
            if (this.EveSmokePersist.hushedstate === true) {
                value |= (1 << 25);    // 25th bit, alarms muted
            }

            returnValue = value >>> 0;  // Ensure UINT32
        }
        return returnValue;
    }

    #EveWaterGuardGetDetails(getOptions) {
        // returns an encoded value formatted for an Eve Water Guard
        if (typeof getOptions === 'function') {
            // Fill in details we might want to be dynamic
            this.EveWaterGuardPersist = getOptions(this.EveWaterGuardPersist);
        }

        let value = util.format(
            '0002 5b00 0302 %s 9b04 %s 8608 %s 4e01 %s %s 1e02 5b00 0c',
            numberToEveHexString(this.EveWaterGuardPersist.firmware, 4),  // firmware version (build xxxx)
            numberToEveHexString(Math.floor(Date.now() / 1000), 8), // 'now' time
            numberToEveHexString(this.EveWaterGuardPersist.lastalarmtest, 8),    // Not sure why 64bit value???
            numberToEveHexString(this.EveWaterGuardPersist.muted === true ? 1 : 0, 2));    // Alarm mute status

        return encodeEveData(value);
    }

    #EveHistoryStatus() {
        let tempHistory = this.getHistory(this.EveHome.type, this.EveHome.sub); // get flattened history array for easier processing
        let historyTime = (tempHistory.length === 0 ? Math.floor(Date.now() / 1000) : tempHistory[tempHistory.length - 1].time);
        this.EveHome.reftime = (tempHistory.length === 0 ? (this.historyData.reset - EPOCH_OFFSET) : (tempHistory[0].time - EPOCH_OFFSET));
        this.EveHome.count = tempHistory.length;    // Number of history entries for this type

        let value = util.format(
            '%s 00000000 %s %s %s %s %s %s 000000000101',
            numberToEveHexString(historyTime - this.EveHome.reftime - EPOCH_OFFSET, 8),
            numberToEveHexString(this.EveHome.reftime, 8), // reference time (time of first history??)
            numberToEveHexString(this.EveHome.fields.trim().match(/\S*[0-9]\S*/g).length, 2), // Calclate number of fields we have
            this.EveHome.fields.trim(),    // Fields listed in string. Each field is seperated by spaces
            numberToEveHexString(this.EveHome.count, 4), // count of entries
            numberToEveHexString(this.maxEntries === 0 ? MAX_HISTORY_SIZE : this.maxEntries, 4),  // history max size
            numberToEveHexString(1, 8));  // first entry

        if (this?.log?.debug) {
            this.log.debug('#EveHistoryStatus: history for "%s:%s" (%s) - Entries %s', this.EveHome.type, this.EveHome.sub, this.EveHome.evetype, this.EveHome.count);
        }
        return encodeEveData(value);
    }

    #EveHistoryEntries() {
        // Streams our history data back to EveHome when requested
        let dataStream = '';
        if (this.EveHome.entry <= this.EveHome.count && this.EveHome.send !== 0) {
            let tempHistory = this.getHistory(this.EveHome.type, this.EveHome.sub); // get flattened history array for easier processing

            // Generate eve home history header for data following
            let data = util.format(
                '%s 0100 0000 81 %s 0000 0000 00 0000',
                numberToEveHexString(this.EveHome.entry, 8),
                numberToEveHexString(this.EveHome.reftime, 8));

            // Format the data string, including calculating the number of 'bytes' the data fits into
            data = data.replace(/ /g, '');
            dataStream += util.format('%s %s', (data.length / 2 + 1).toString(16), data);

            for (let i = 0; i < EVEHOME_MAX_STREAM; i++) {
                if (tempHistory.length !== 0 && (this.EveHome.entry - 1) <= tempHistory.length) {
                    let historyEntry = tempHistory[this.EveHome.entry - 1]; // need to map EveHome entry address to our data history, as EvenHome addresses start at 1
                    let data = util.format(
                        '%s %s',
                        numberToEveHexString(this.EveHome.entry, 8),
                        numberToEveHexString(historyEntry.time - this.EveHome.reftime - EPOCH_OFFSET, 8),
                    );  // Create the common header data for eve entry

                    switch (this.EveHome.evetype) {
                        case 'aqua' : {
                            // 1f01 2a08 2302
                            // 1f - InUse
                            // 2a - Water Usage (ml)
                            // 23 - Battery millivolts
                            data += util.format(
                                '%s %s %s %s',
                                numberToEveHexString((historyEntry.status === 0 ? parseInt('111', 2) : parseInt('101', 2)), 2),   // Field mask, 111 is for sending water usage when a valve is recorded as closed, 101 is for when valve is recorded as opened, no water usage is sent
                                numberToEveHexString(historyEntry.status, 2),
                                (historyEntry.status === 0 ? numberToEveHexString(Math.floor(parseFloat(historyEntry.water) * 1000), 16) : ''),   // water used in millilitres if valve closed entry (64bit value)
                                numberToEveHexString(3120, 4)); // battery millivolts - 3120mv which think should be 100% for an eve aqua running on 2 x AAs??
                            break;
                        }

                        case 'room' : {
                            // 0102 0202 0402 0f03
                            // 01 - Temperature
                            // 02 - Humidity
                            // 04 - Air Quality (ppm)
                            // 0f - VOC Heat Sense??
                            data += util.format(
                                '%s %s %s %s %s',
                                numberToEveHexString(parseInt('1111', 2), 2), // Field include/exclude mask
                                numberToEveHexString(historyEntry.temperature * 100, 4), // temperature
                                numberToEveHexString(historyEntry.humidity * 100, 4), // Humidity
                                numberToEveHexString(typeof historyEntry?.ppm === 'number' ? historyEntry.ppm * 10 : 10, 4), // PPM - air quality
                                numberToEveHexString(0, 6));    // VOC??
                            break;
                        }

                        case 'room2' : {
                            // 0102 0202 2202 2901 2501 2302 2801
                            // 01 - Temperature
                            // 02 - Humidity
                            // 22 - VOC Density (ppb)
                            // 29 - ??
                            // 25 - Battery level %
                            // 23 - Battery millivolts
                            // 28 - ??
                            data += util.format(
                                '%s %s %s %s %s %s %s %s',
                                numberToEveHexString(parseInt('1111111', 2), 2),   // Field include/exclude mask
                                numberToEveHexString(historyEntry.temperature * 100, 4), // temperature
                                numberToEveHexString(historyEntry.humidity * 100, 4), // Humidity
                                numberToEveHexString(typeof historyEntry?.voc === 'number' ? historyEntry.voc : 0, 4), // VOC - air quality in ppm
                                numberToEveHexString(0, 2), // ??
                                numberToEveHexString(100, 2), // battery level % - 100%
                                numberToEveHexString(4771, 4), // battery millivolts - 4771mv
                                numberToEveHexString(1, 2));    // ??
                            break;
                        }

                        case 'weather' : {
                            // 0102 0202 0302
                            // 01 - Temperature
                            // 02 - Humidity
                            // 03 - Air Pressure
                            data += util.format(
                                '%s %s %s %s',
                                numberToEveHexString(parseInt('111', 2), 2),   // Field include/exclude mask
                                numberToEveHexString(historyEntry.temperature * 100, 4), // temperature
                                numberToEveHexString(historyEntry.humidity * 100, 4), // Humidity
                                numberToEveHexString(typeof historyEntry?.pressure === 'number' ? historyEntry.pressure * 10 : 10, 4)); // Pressure
                            break;
                        }

                        case 'motion' : {
                            // 1301 1c01
                            // 13 - Motion detected
                            // 1c - Motion currently active??
                            data += util.format(
                                '%s %s',
                                numberToEveHexString(parseInt('10', 2), 2),    // Field include/exclude mask
                                numberToEveHexString(historyEntry.status, 2));
                            break;
                        }

                        case 'contact' :
                        case 'switch' : {
                            // contact, motion and switch sensors treated the same for status
                            // 0601
                            // 06 - Contact status 0 = no contact, 1 = contact
                            data += util.format(
                                '%s %s',
                                numberToEveHexString(parseInt('1', 2), 2), // Field include/exclude mask
                                numberToEveHexString(historyEntry.status, 2));
                            break;
                        }

                        case 'door' : {
                            // Invert status for EveHome. As EveHome door is a contact sensor, where 1 is contact and 0 is no contact, opposite of what we expect a door to be
                            // ie: 0 = closed, 1 = opened
                            // 0601
                            // 06 - Contact status 0 = no contact, 1 = contact
                            data += util.format(
                                '%s %s',
                                numberToEveHexString(parseInt('1', 2), 2), // Field include/exclude mask
                                numberToEveHexString(historyEntry.status === 1 ? 0 : 1, 2));  // status for EveHome (inverted ie: 1 = closed, 0 = opened) */
                            break;
                        }

                        case 'thermo' : {
                            // 0102 0202 1102 1001 1201 1d01
                            // 01 - Temperature
                            // 02 - Humidity
                            // 11 - Target Temperature
                            // 10 - Valve percentage
                            // 12 - Thermo target
                            // 1d - Open window
                            let tempTarget = 0;
                            if (typeof historyEntry.target === 'object') {
                                if (historyEntry.target.low === 0 && historyEntry.target.high !== 0) {
                                    tempTarget = historyEntry.target.high;   // heating limit
                                }
                                if (historyEntry.target.low !== 0 && historyEntry.target.high !== 0) {
                                    tempTarget = historyEntry.target.high;   // range, so using heating limit
                                }
                                if (historyEntry.target.low !== 0 && historyEntry.target.high === 0) {
                                    tempTarget = 0;   // cooling limit
                                }
                                if (historyEntry.target.low === 0 && historyEntry.target.high === 0) {
                                    tempTarget = 0;   // off
                                }
                            }

                            data += util.format(
                                '%s %s %s %s %s %s %s',
                                numberToEveHexString(parseInt('111111', 2), 2),    // Field include/exclude mask
                                numberToEveHexString(historyEntry.temperature * 100, 4), // temperature
                                numberToEveHexString(historyEntry.humidity * 100, 4), // Humidity
                                numberToEveHexString(tempTarget * 100, 4), // target temperature for heating
                                numberToEveHexString(historyEntry.status === 2 ? 100 : historyEntry.status === 3 ? 50 : 0, 2), // 0% valve position = off, 50% = cooling, 100% = heating
                                numberToEveHexString(0, 2), // Thermo target
                                numberToEveHexString(0, 2)); // Window open status 0 = window closed, 1 = open
                            break;
                        }

                        case 'energy' : {
                            // 0702 0e01
                            // 07 - Power10thWh
                            // 0e - on/off
                            data += util.format(
                                '%s %s %s',
                                numberToEveHexString(parseInt('11', 2), 2),    // Field include/exclude mask
                                numberToEveHexString(historyEntry.watts * 10, 4),   // Power in watts
                                numberToEveHexString(historyEntry.status, 2));  // Power status, 1 = on, 0 = off
                            break;
                        }

                        case 'smoke' : {
                            // TODO - What do we send back??
                            break;
                        }

                        case 'blind' : {
                            // TODO - What do we send back??
                            break;
                        }

                        case 'waterguard' : {
                            // TODO - What do we send back??
                            break;
                        }
                    }

                    // Format the data string, including calculating the number of 'bytes' the data fits into
                    data = data.replace(/ /g, '');
                    dataStream += util.format('%s%s', numberToEveHexString(data.length / 2 + 1, 2), data);

                    this.EveHome.entry++;
                    if (this.EveHome.entry > this.EveHome.count) {
                        break;
                    }
                }
            }
            if (this.EveHome.entry > this.EveHome.count) {
                // No more history data to send back
                this?.log?.debug && this.log.debug('#EveHistoryEntries: sent "%s" entries to EveHome ("%s") for "%s:%s"', this.EveHome.send, this.EveHome.evetype, this.EveHome.type, this.EveHome.sub);
                this.EveHome.send = 0;  // no more to send
                dataStream += '00';
            }
        } else {
            // We're not transferring any data back
            this?.log?.debug && this.log.debug('#EveHistoryEntries: do we ever get here.....???', this.EveHome.send, this.EveHome.evetype, this.EveHome.type, this.EveHome.sub, this.EveHome.entry);
            this.EveHome.send = 0;  // no more to send
            dataStream = '00';
        }
        return encodeEveData(dataStream);
    }

    #EveHistoryRequest(value, callback) {
        // Requesting history, starting at specific entry
        this.EveHome.entry = EveHexStringToNumber(decodeEveData(value).substring(4, 12));    // Starting entry
        if (this.EveHome.entry === 0) {
            this.EveHome.entry = 1; // requested to restart from beginning of history for sending to EveHome
        }
        this.EveHome.send = (this.EveHome.count - this.EveHome.entry + 1);    // Number of entries we're expected to send
        callback();

        this?.log?.debug && this.log.debug('#EveHistoryRequest: requested address', this.EveHome.entry);
    }

    #EveSetTime(value) {
        // Time stamp from EveHome
        let timestamp = (EPOCH_OFFSET + EveHexStringToNumber(decodeEveData(value)));

        this?.log?.debug && this.log.debug('#EveSetTime: timestamp offset', new Date(timestamp * 1000));
    }
}


// General functions
function encodeEveData(data) {
    if (typeof data !== 'string') {
        // Since passed in data wasn't as string, return 'undefined'
        return;
    }
    return String(Buffer.from(data.replace(/[^a-fA-F0-9]/ig, ''), 'hex').toString('base64'));
}

function decodeEveData(data) {
    if (typeof data !== 'string') {
        // Since passed in data wasn't as string, return 'undefined'
        return;
    }
    return String(Buffer.from(data, 'base64').toString('hex'));
}

// Converts a signed integer number OR float value into a string for EveHome, including formatting to byte width and reverse byte order
function numberToEveHexString(number, padtostringlength, precision) {
    if (typeof number !== 'number' || typeof padtostringlength !== 'number' || padtostringlength % 2 !== 0) {
        return;
    }

    let buffer = Buffer.alloc(8);   // Max size of buffer needed for 64bit value
    if (precision === undefined) {
        // Handle integer value
        buffer.writeIntLE(number, 0, 6);    // Max 48bit value for signed integers
    }
    if (precision !== undefined && typeof precision === 'number') {
        // Handle float value
        buffer.writeFloatLE(number, 0);
    }
    return String(buffer.toString('hex').padEnd(padtostringlength, '0').slice(0, padtostringlength));
}

// Converts Eve encoded hex string to a signed integer value OR float value with number of precission digits
function EveHexStringToNumber(string, precision) {
    if (typeof string !== 'string') {
        return;
    }

    let buffer = Buffer.from(string, 'hex');
    let number = NaN; // Value not defined yet
    if (precision === undefined) {
        // Handle integer value
        number = Number(buffer.readIntLE(0, buffer.length));
    }
    if (precision !== undefined && typeof precision === 'number') {
        // Handle float value
        let float = buffer.readFloatLE(0);
        number = Number(typeof precision === 'number' && precision > 0 ? float.toFixed(precision) : float);
    }
    return number;
}

// Define HomeKit characteristics

// Eve Reset Total
export class EveResetTotal extends HAP.Characteristic {
    static UUID = 'E863F112-079E-48FF-8F27-9C2605A29F52';

    constructor() {
        super('Eve Reset Total', EveResetTotal.UUID, {
            format: HAP.Formats.UINT32,
            unit: HAP.Units.SECONDS, // since 2001/01/01
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY, HAP.Perms.PAIRED_WRITE],
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.EveResetTotal = EveResetTotal;

// EveHistoryStatus
export class EveHistoryStatus extends HAP.Characteristic {
    static UUID = 'E863F116-079E-48FF-8F27-9C2605A29F52';

    constructor() {
        super('Eve History Status', EveHistoryStatus.UUID, {
            format: HAP.Formats.DATA,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY, HAP.Perms.HIDDEN],
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.EveHistoryStatus = EveHistoryStatus;

// EveHistoryEntries
export class EveHistoryEntries extends HAP.Characteristic {
    static UUID = 'E863F117-079E-48FF-8F27-9C2605A29F52';

    constructor() {
        super('Eve History Entries', EveHistoryEntries.UUID, {
            format: HAP.Formats.DATA,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY, HAP.Perms.HIDDEN],
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.EveHistoryEntries = EveHistoryEntries;

// EveHistoryRequest
export class EveHistoryRequest extends HAP.Characteristic {
    static UUID = 'E863F11C-079E-48FF-8F27-9C2605A29F52';

    constructor() {
        super('Eve History Request', EveHistoryRequest.UUID, {
            format: HAP.Formats.DATA,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY, HAP.Perms.HIDDEN],
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.EveHistoryRequest = EveHistoryRequest;

// EveSetTime
export class EveSetTime extends HAP.Characteristic {
    static UUID = 'E863F121-079E-48FF-8F27-9C2605A29F52';

    constructor() {
        super('Eve SetTime', EveSetTime.UUID, {
            format: HAP.Formats.DATA,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY, HAP.Perms.HIDDEN],
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.EveSetTime = EveSetTime;

export class EveValvePosition extends HAP.Characteristic {
    static UUID = 'E863F12E-079E-48FF-8F27-9C2605A29F52';

    constructor() {
        super('Eve Valve Position', EveValvePosition.UUID, {
            format: HAP.Formats.UINT8,
            unit: HAP.Units.PERCENTAGE,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.EveValvePosition = EveValvePosition;

export class EveLastActivation extends HAP.Characteristic {
    static UUID = 'E863F11A-079E-48FF-8F27-9C2605A29F52';

    constructor() {
        super('Eve Last Activation', EveLastActivation.UUID, {
            format: HAP.Formats.UINT32,
            unit: HAP.Units.SECONDS,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.EveLastActivation = EveLastActivation;

export class EveTimesOpened extends HAP.Characteristic {
    static UUID = 'E863F129-079E-48FF-8F27-9C2605A29F52';
    constructor() {
        super('Eve Times Opened', EveTimesOpened.UUID, {
            format: HAP.Formats.UINT32,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.EveTimesOpened = EveTimesOpened;

export class EveClosedDuration extends HAP.Characteristic {
    static UUID = 'E863F118-079E-48FF-8F27-9C2605A29F52';

    constructor() {
        super('Eve Closed Duration', EveClosedDuration.UUID, {
            format: HAP.Formats.UINT32,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.EveClosedDuration = EveClosedDuration;

export class EveOpenDuration extends HAP.Characteristic {
    static UUID = 'E863F119-079E-48FF-8F27-9C2605A29F52';

    constructor() {
        super('Eve Opened Duration', EveOpenDuration.UUID, {
            format: HAP.Formats.UINT32,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.EveOpenDuration = EveOpenDuration;

export class EveProgramCommand extends HAP.Characteristic {
    static UUID = 'E863F12C-079E-48FF-8F27-9C2605A29F52';

    constructor() {
        super('Eve Program Command', EveProgramCommand.UUID, {
            format: HAP.Formats.DATA,
            perms: [HAP.Perms.PAIRED_WRITE],
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.EveProgramCommand = EveProgramCommand;

export class EveProgramData extends HAP.Characteristic {
    static UUID = 'E863F12F-079E-48FF-8F27-9C2605A29F52';

    constructor() {
        super('Eve Program Data', EveProgramData.UUID, {
            format: HAP.Formats.DATA,
            perms: [HAP.Perms.PAIRED_WRITE],
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.EveProgramData = EveProgramData;

export class EveElectricalVoltage extends HAP.Characteristic {
    static UUID = 'E863F10A-079E-48FF-8F27-9C2605A29F52';

    constructor() {
        super('Eve Voltage', EveElectricalVoltage.UUID, {
            format: HAP.Formats.FLOAT,
            unit: 'V',
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.EveElectricalVoltage = EveElectricalVoltage;

export class EveElectricalCurrent extends HAP.Characteristic {
    static UUID = 'E863F126-079E-48FF-8F27-9C2605A29F52';

    constructor() {
        super('Eve Current', EveElectricalCurrent.UUID, {
            format: HAP.Formats.FLOAT,
            unit: 'A',
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.EveElectricalCurrent = EveElectricalCurrent;

export class EveTotalConsumption extends HAP.Characteristic {
    static UUID = 'E863F10C-079E-48FF-8F27-9C2605A29F52';

    constructor() {
        super('Eve Total Consumption', EveTotalConsumption.UUID, {
            format: HAP.Formats.FLOAT,
            unit: 'kWh',
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.EveTotalConsumption = EveTotalConsumption;

export class EveElectricalWattage extends HAP.Characteristic {
    static UUID = 'E863F10D-079E-48FF-8F27-9C2605A29F52';

    constructor() {
        super('Eve Watts', EveElectricalWattage.UUID, {
            format: HAP.Formats.FLOAT,
            unit: 'W',
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.EveElectricalWattage = EveElectricalWattage;

export class EveGetConfiguration extends HAP.Characteristic {
    static UUID = 'E863F131-079E-48FF-8F27-9C2605A29F52';

    constructor() {
        super('Eve Get Configuration', EveGetConfiguration.UUID, {
            format: HAP.Formats.DATA,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.EveGetConfiguration = EveGetConfiguration;

export class EveSetConfiguration extends HAP.Characteristic {
    static UUID = 'E863F11D-079E-48FF-8F27-9C2605A29F52';

    constructor() {
        super('Eve Set Configuration', EveSetConfiguration.UUID, {
            format: HAP.Formats.DATA,
            perms: [HAP.Perms.PAIRED_WRITE, HAP.Perms.HIDDEN],
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.EveSetConfiguration = EveSetConfiguration;

export class EveFirmware extends HAP.Characteristic {
    static UUID = 'E863F11E-079E-48FF-8F27-9C2605A29F52';

    constructor() {
        super('Eve Firmware', EveFirmware.UUID, {
            format: HAP.Formats.DATA,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.PAIRED_WRITE, HAP.Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.EveFirmware = EveFirmware;

export class EveSensitivity extends HAP.Characteristic {
    static UUID = 'E863F120-079E-48FF-8F27-9C2605A29F52';
    static HIGH = 0;
    static MEDIUM = 4;
    static LOW = 7;

    constructor() {
        super('Eve Motion Sensitivity', EveSensitivity.UUID, {
            format: HAP.Formats.UINT8,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.PAIRED_WRITE, HAP.Perms.NOTIFY],
            minValue: 0,
            maxValue: 7,
            validValues: [0, 4, 7],
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.EveSensitivity = EveSensitivity;

export class EveDuration extends HAP.Characteristic {
    static UUID = 'E863F12D-079E-48FF-8F27-9C2605A29F52';

    constructor() {
        super('Eve Motion Duration', EveDuration.UUID, {
            format: HAP.Formats.UINT16,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.PAIRED_WRITE, HAP.Perms.NOTIFY],
            minValue: 5,
            maxValue: 54000,
            validValues: [5, 10, 20, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 10800, 18000, 36000, 43200, 54000],
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.EveDuration = EveDuration;

export class EveDeviceStatus extends HAP.Characteristic {
    static UUID = 'E863F134-079E-48FF-8F27-9C2605A29F52';
    static SMOKE_DETECTED = (1 << 0);
    static HEAT_DETECTED = (1 << 1);
    static ALARM_TEST_ACTIVE = (1 << 2);
    static SMOKE_SENSOR_ERROR = (1 << 5);
    static HEAT_SENSOR_ERROR = (1 << 7);
    static SMOKE_CHAMBER_ERROR = (1 << 9);
    static SMOKE_SENSOR_DEACTIVATED = (1 << 14);
    static FLASH_STATUS_LED = (1 << 15);
    static ALARM_PAUSED = (1 << 24);
    static ALARM_MUTED = (1 << 25);

    constructor() {
        super('Eve Device Status', EveDeviceStatus.UUID, {
            format: HAP.Formats.UINT32,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.EveDeviceStatus = EveDeviceStatus;

export class EveAirPressure extends HAP.Characteristic {
    static UUID = 'E863F10F-079E-48FF-8F27-9C2605A29F52';

    constructor() {
        super('Eve Air Pressure', EveAirPressure.UUID, {
            format: HAP.Formats.UINT16,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
            unit: 'hPa',
            minValue: 700,
            maxValue: 1100,
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.EveAirPressure = EveAirPressure;

export class EveElevation extends HAP.Characteristic {
    static UUID = 'E863F130-079E-48FF-8F27-9C2605A29F52';

    constructor() {
        super('Eve Elevation', EveElevation.UUID, {
            format: HAP.Formats.INT,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.PAIRED_WRITE, HAP.Perms.NOTIFY],
            unit: 'm',
            minValue: -430,
            maxValue: 8850,
            minStep: 10,
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.EveElevation = EveElevation;

export class EveVOCLevel extends HAP.Characteristic {
    static UUID = 'E863F10B-079E-48FF-8F27-9C2605A29F5';

    constructor() {
        super('VOC Level', EveVOCLevel.UUID, {
            format: HAP.Formats.UINT16,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
            unit: 'ppm',
            minValue: 5,
            maxValue: 5000,
            minStep: 5,
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.EveVOCLevel = EveVOCLevel;

export class EveWeatherTrend extends HAP.Characteristic {
    static UUID = 'E863F136-079E-48FF-8F27-9C2605A29F52';
    static BLANK = 0; // also: 2, 8, 10
    static SUN = 1; // also: 9
    static CLOUDS_SUN = 3; // also: 11
    static RAIN = 4; // also: 5, 6, 7
    static RAIN_WIND = 12; // also: 13, 14, 15

    constructor() {
        super('Eve Weather Trend', EveWeatherTrend.UUID, {
            format: HAP.Formats.UINT8,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
            minValue: 0,
            maxValue: 15,
            minStep: 1,
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.EveWeatherTrend = EveWeatherTrend;

// EveHomeHistory Service
export class EveHomeHistory extends HAP.Service {
    static UUID = 'E863F007-079E-48FF-8F27-9C2605A29F52';

    constructor(displayName, subtype) {
        super(displayName, EveHomeHistory.UUID, subtype);

        // Required Characteristics
        this.addCharacteristic(HAP.Characteristic.EveResetTotal);
        this.addCharacteristic(HAP.Characteristic.EveHistoryStatus);
        this.addCharacteristic(HAP.Characteristic.EveHistoryEntries);
        this.addCharacteristic(HAP.Characteristic.EveHistoryRequest);
        this.addCharacteristic(HAP.Characteristic.EveSetTime);
    }
}
HAP.Service.EveHomeHistory = EveHomeHistory;


// Eve custom air pressure service
export class EveAirPressureSensor extends HAP.Service {
    static UUID = 'E863F00A-079E-48FF-8F27-9C2605A29F52';

    constructor(displayName, subtype) {
        super(displayName, EveAirPressureSensor.UUID, subtype);

        // Required Characteristics
        this.addCharacteristic(HAP.Characteristic.EveAirPressure);
        this.addCharacteristic(HAP.Characteristic.EveElevation);
    }
}
HAP.Service.EveAirPressureSensor = EveAirPressureSensor;


// Other UUIDs Eve Home recognises
export class ApparentTemperature extends HAP.Characteristic {
    static UUID = 'C1283352-3D12-4777-ACD5-4734760F1AC8';

    constructor() {
        super('Apparent Temperature', ApparentTemperature.UUID, {
            format: HAP.Formats.FLOAT,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
            unit: HAP.Units.CELSIUS,
            minValue: -40,
            maxValue: 100,
            minStep: 0.1,
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.ApparentTemperature = ApparentTemperature;

export class CloudCover extends HAP.Characteristic {
    static UUID = '64392FED-1401-4F7A-9ADB-1710DD6E3897';

    constructor() {
        super('Cloud Cover', CloudCover.UUID, {
            format: HAP.Formats.UINT8,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
            unit: HAP.Units.PERCENTAGE,
            minValue: 0,
            maxValue: 100,
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.CloudCover = CloudCover;

export class Condition extends HAP.Characteristic {
    static UUID = 'CD65A9AB-85AD-494A-B2BD-2F380084134D';

    constructor() {
        super('Condition', Condition.UUID, {
            format: HAP.Formats.STRING,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.Condition = Condition;

export class ConditionCategory extends HAP.Characteristic {
    static UUID = 'CD65A9AB-85AD-494A-B2BD-2F380084134C';

    constructor() {
        super('Condition Category', ConditionCategory.UUID, {
            format: HAP.Formats.UINT8,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
            minValue: 0,
            maxValue: 9,
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.ConditionCategory = ConditionCategory;

export class DewPoint extends HAP.Characteristic {
    static UUID = '095C46E2-278E-4E3C-B9E7-364622A0F501';

    constructor() {
        super('Dew Point', DewPoint.UUID, {
            format: HAP.Formats.FLOAT,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
            unit: HAP.Units.CELSIUS,
            minValue: -40,
            maxValue: 100,
            minStep: 0.1,
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.DewPoint = DewPoint;

export class ForecastDay extends HAP.Characteristic {
    static UUID = '57F1D4B2-0E7E-4307-95B5-808750E2C1C7';

    constructor() {
        super('Day', ForecastDay.UUID, {
            format: HAP.Formats.STRING,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.ForecastDay = ForecastDay;

export class MaximumWindSpeed extends HAP.Characteristic {
    static UUID = '6B8861E5-D6F3-425C-83B6-069945FFD1F1';

    constructor() {
        super('Maximum Wind Speed', MaximumWindSpeed.UUID, {
            format: HAP.Formats.FLOAT,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
            unit: 'km/h',
            minValue: 0,
            maxValue: 150,
            minStep: 0.1,
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.MaximumWindSpeed = MaximumWindSpeed;

export class MinimumTemperature extends HAP.Characteristic {
    static UUID = '707B78CA-51AB-4DC9-8630-80A58F07E411';

    constructor() {
        super('Maximum Wind Speed', MinimumTemperature.UUID, {
            format: HAP.Formats.FLOAT,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
            unit: HAP.Units.CELSIUS,
            minValue: -40,
            maxValue: 100,
            minStep: 0.1,
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.MinimumTemperature = MinimumTemperature;

export class ObservationStation extends HAP.Characteristic {
    static UUID = 'D1B2787D-1FC4-4345-A20E-7B5A74D693ED';

    constructor() {
        super('Observation Station', ObservationStation.UUID, {
            format: HAP.Formats.STRING,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.ObservationStation = ObservationStation;

export class ObservationTime extends HAP.Characteristic {
    static UUID = '234FD9F1-1D33-4128-B622-D052F0C402AF';

    constructor() {
        super('Observation Time', ObservationTime.UUID, {
            format: HAP.Formats.STRING,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.ObservationTime = ObservationTime;

export class Ozone extends HAP.Characteristic {
    static UUID = 'BBEFFDDD-1BCD-4D75-B7CD-B57A90A04D13';

    constructor() {
        super('Ozone', Ozone.UUID, {
            format: HAP.Formats.UINT8,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
            unit: 'DU',
            minValue: 0,
            maxValue: 500,
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.Ozone = Ozone;

export class Rain extends HAP.Characteristic {
    static UUID = 'F14EB1AD-E000-4EF4-A54F-0CF07B2E7BE7';

    constructor() {
        super('Rain', Rain.UUID, {
            format: HAP.Formats.BOOL,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.Rain = Rain;

export class RainLastHour extends HAP.Characteristic {
    static UUID = '10C88F40-7EC4-478C-8D5A-BD0C3CCE14B7';

    constructor() {
        super('Rain Last Hour', RainLastHour.UUID, {
            format: HAP.Formats.UINT16,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
            unit: 'mm',
            minValue: 0,
            maxValue: 200,
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.RainLastHour = RainLastHour;

export class RainProbability extends HAP.Characteristic {
    static UUID = 'FC01B24F-CF7E-4A74-90DB-1B427AF1FFA3';

    constructor() {
        super('Rain Probability', RainProbability.UUID, {
            format: HAP.Formats.UINT8,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
            unit: HAP.Units.PERCENTAGE,
            minValue: 0,
            maxValue: 100,
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.RainProbability = RainProbability;

export class TotalRain extends HAP.Characteristic {
    static UUID = 'CCC04890-565B-4376-B39A-3113341D9E0F';

    constructor() {
        super('Total Rain', TotalRain.UUID, {
            format: HAP.Formats.UINT16,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
            unit: 'mm',
            minValue: 0,
            maxValue: 2000,
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.TotalRain = TotalRain;

export class Snow extends HAP.Characteristic {
    static UUID = 'F14EB1AD-E000-4CE6-BD0E-384F9EC4D5DD';

    constructor() {
        super('Snow', Snow.UUID, {
            format: HAP.Formats.BOOL,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.Snow = Snow;

export class SolarRadiation extends HAP.Characteristic {
    static UUID = '1819A23E-ECAB-4D39-B29A-7364D299310B';

    constructor() {
        super('Solar Radiation', SolarRadiation.UUID, {
            format: HAP.Formats.UINT16,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
            unit: 'W/m²',
            minValue: 0,
            maxValue: 2000,
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.SolarRadiation = SolarRadiation;

export class SunriseTime extends HAP.Characteristic {
    static UUID = '0D96F60E-3688-487E-8CEE-D75F05BB3008';
    constructor() {
        super('Sunrise', SunriseTime.UUID, {
            format: HAP.Formats.STRING,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.SunriseTime = SunriseTime;

export class SunsetTime extends HAP.Characteristic {
    static UUID = '3DE24EE0-A288-4E15-A5A8-EAD2451B727C';

    constructor() {
        super('Sunset', SunsetTime.UUID, {
            format: HAP.Formats.STRING,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.SunsetTime = SunsetTime;

export class UVIndex extends HAP.Characteristic {
    static UUID = '05BA0FE0-B848-4226-906D-5B64272E05CE';

    constructor() {
        super('UV Index', UVIndex.UUID, {
            format: HAP.Formats.UINT8,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
            minValue: 0,
            maxValue: 16,
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.UVIndex = UVIndex;

export class Visibility extends HAP.Characteristic {
    static UUID = 'D24ECC1E-6FAD-4FB5-8137-5AF88BD5E857';

    constructor() {
        super('Visibility', Visibility.UUID, {
            format: HAP.Formats.UINT8,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
            unit: 'km',
            minValue: 0,
            maxValue: 100,
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.Visibility = Visibility;

export class WindDirection extends HAP.Characteristic {
    static UUID = '46F1284C-1912-421B-82F5-EB75008B167E';
    constructor() {
        super('Wind Direction', WindDirection.UUID, {
            format: HAP.Formats.STRING,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.WindDirection = WindDirection;

export class WindSpeed extends HAP.Characteristic {
    static UUID = '49C8AE5A-A3A5-41AB-BF1F-12D5654F9F41';

    constructor() {
        super('Wind Speed', WindSpeed.UUID, {
            format: HAP.Formats.FLOAT,
            perms: [HAP.Perms.PAIRED_READ, HAP.Perms.NOTIFY],
            unit: 'km/h',
            minValue: 0,
            maxValue: 150,
            minStep: 0.1,
        });
        this.value = this.getDefaultValue();
    }
}
HAP.Characteristic.WindSpeed = WindSpeed;