// Taken from https://github.com/homebridge/homebridge/blob/latest/src/logger.ts
// Converted back to JS for using under HAP-NodeJS library directly
// Removed depricated functions

import console from 'node:console';
import util from 'node:util';
import chalk from 'chalk';

/**
 * Log levels to indicate importance of the logged message.
 * Every level corresponds to a certain color.
 *
 * - INFO: no color
 * - SUCCESS: green
 * - WARN: yellow
 * - ERROR: red
 * - DEBUG: gray
 *
 * Messages with DEBUG level are only displayed if explicitly enabled.
 */
export const LogLevel = {
  INFO: 'info',
  SUCCESS: 'success',
  WARN: 'warn',
  ERROR: 'error',
  DEBUG: 'debug',
};

/**
 * Logger class
 */
export default class Logger {
  static internal = new Logger();

  static loggerCache = new Map(); // global cache of logger instances by plugin name
  static #debugEnabled = false;
  static #timestampEnabled = true;

  prefix;

  constructor(prefix) {
    this.prefix = prefix;
  }

  /**
   * Creates a new Logging device with a specified prefix.
   *
   * @param prefix {string} - the prefix of the logger
   */
  static withPrefix(prefix) {
    const loggerStuff = Logger.loggerCache.get(prefix);

    if (loggerStuff) {
      return loggerStuff;
    } else {
      const logger = new Logger(prefix);

      const log = logger.info.bind(logger);
      log.info = logger.info;
      log.success = logger.success;
      log.warn = logger.warn;
      log.error = logger.error;
      log.debug = logger.debug;
      log.log = logger.log;

      log.prefix = logger.prefix;

      const logging = log;
      Logger.loggerCache.set(prefix, logging);
      return logging;
    }
  }

  /**
   * Turns on debug level logging. Off by default.
   *
   * @param enabled {boolean}
   */
  static setDebugEnabled(enabled) {
    if (enabled === undefined) {
      enabled = true;
    }
    Logger.#debugEnabled = enabled;
  }

  /**
   * Turns on inclusion of timestamps in log messages. On by default.
   *
   * @param enabled {boolean}
   */
  static setTimestampEnabled(enabled) {
    if (enabled === undefined) {
      enabled = true;
    }
    Logger.#timestampEnabled = enabled;
  }

  /**
   * Forces color in logging output, even if it seems like color is unsupported.
   */
  static forceColor() {
    chalk.level = 1; // `1` - Basic 16 colors support.
  }

  info(message, ...parameters) {
    this.log(LogLevel.INFO, message, ...parameters);
  }

  success(message, ...parameters) {
    this.log(LogLevel.SUCCESS, message, ...parameters);
  }

  warn(message, ...parameters) {
    this.log(LogLevel.WARN, message, ...parameters);
  }

  error(message, ...parameters) {
    this.log(LogLevel.ERROR, message, ...parameters);
  }

  debug(message, ...parameters) {
    this.log(LogLevel.DEBUG, message, ...parameters);
  }

  log(level, message, ...parameters) {
    if (level === LogLevel.DEBUG && !Logger.#debugEnabled) {
      return;
    }

    message = util.format(message, ...parameters);

    let loggingFunction = console.log;
    switch (level) {
      case LogLevel.SUCCESS:
        message = chalk.green(message);
        break;
      case LogLevel.WARN:
        message = chalk.yellow(message);
        loggingFunction = console.error;
        break;
      case LogLevel.ERROR:
        message = chalk.red(message);
        loggingFunction = console.error;
        break;
      case LogLevel.DEBUG:
        message = chalk.gray(message);
        break;
    }

    if (this.prefix) {
      message = getLogPrefix(this.prefix) + ' ' + message;
    }

    if (Logger.#timestampEnabled) {
      const date = new Date();
      message = chalk.white(`[${date.toLocaleString()}] `) + message;
    }

    loggingFunction(message);
  }
}

/**
 * Gets the prefix
 * @param prefix
 */
export function getLogPrefix(prefix) {
  return chalk.cyan(`[${prefix}]`);
}
