/**
 * logger.js — structured winston logger
 * All modules import this instead of using console.log
 */
const { createLogger, format, transports } = require('winston');
const { combine, timestamp, colorize, printf, errors } = format;

const fmt = printf(({ level, message, timestamp, stack, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  return `${timestamp} [${level}] ${stack || message}${metaStr}`;
});

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'HH:mm:ss.SSS' }),
    colorize(),
    fmt
  ),
  transports: [new transports.Console()],
});

module.exports = logger;
