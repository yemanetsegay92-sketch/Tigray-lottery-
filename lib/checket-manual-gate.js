'use strict';
// Explicit opt-in; never activated by this upgrade.
function manualCheckEtAllowed(env=process.env){return ['production','preview'].includes(env.VERCEL_ENV) && env.LOTTERY_CHECKET_READ_ONLY_ENABLED==='true';}
module.exports={manualCheckEtAllowed};
