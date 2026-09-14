/**
 * 开发态启动入口，等价于 node scripts/launch.js --app [参数...]。
 * 保留本文件是为了让 `node start.js` 这一既有用法继续可用。
 */
process.argv.splice(2, 0, '--app');
require('./scripts/launch.js');
