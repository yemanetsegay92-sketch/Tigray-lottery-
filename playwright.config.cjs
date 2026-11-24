'use strict';
const {defineConfig,devices}=require('@playwright/test');

module.exports=defineConfig({
 testDir:'./tests/cloud-e2e',
 fullyParallel:false,
 workers:1,
 retries:process.env.CI?1:0,
 timeout:45_000,
 expect:{timeout:10_000},
 outputDir:'test-results',
 reporter:[
  ['line'],
  ['html',{outputFolder:'playwright-report',open:'never'}],
  ['junit',{outputFile:'test-artifacts/playwright-junit.xml'}]
 ],
 use:{
  baseURL:'http://127.0.0.1:4174',
  trace:'retain-on-failure',
  screenshot:'on',
  video:'retain-on-failure'
 },
 projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}]
});
