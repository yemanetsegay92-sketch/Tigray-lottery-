const {readdirSync}=require('node:fs');
const {spawnSync}=require('node:child_process');
const files=readdirSync('tools').filter(x=>/^test-.*\.(cjs|mjs)$/.test(x)&& !/firestore|emulator/.test(x)).map(x=>'tools/'+x);
process.exitCode=spawnSync(process.execPath,['--test',...files,'functions/test/dispatch.test.cjs'],{stdio:'inherit'}).status;

if(!process.exitCode)for(const file of ['tools/test-direct-receipts.js','tools/test-payment-lookup.js','tools/test-lottery-cleanup-guards.js']){const result=spawnSync(process.execPath,[file],{stdio:'inherit'});if(result.status){process.exitCode=result.status;break;}}
