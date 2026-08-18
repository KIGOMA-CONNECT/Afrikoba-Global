function log(level, tag, message, extra) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] [${tag}] ${message}`;
  if (extra !== undefined) {
    console.log(line, JSON.stringify(extra));
  } else {
    console.log(line);
  }
}

module.exports = {
  info: (tag, msg, extra) => log('info', tag, msg, extra),
  warn: (tag, msg, extra) => log('warn', tag, msg, extra),
  error: (tag, msg, extra) => log('error', tag, msg, extra),
};
