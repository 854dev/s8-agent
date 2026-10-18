import { managerArgs } from '../lib/manager/launch.mjs';
try { managerArgs('/', process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = 2; }
