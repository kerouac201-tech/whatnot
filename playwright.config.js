import {defineConfig} from '@playwright/test';
export default defineConfig({
 testDir:'./tests',testMatch:'browser.spec.js',workers:1,timeout:30000,
 use:{baseURL:'http://127.0.0.1:3101',headless:true,launchOptions:{executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']},viewport:{width:1440,height:1000},screenshot:'only-on-failure'},
 webServer:{command:'node tests/browser-server.js',url:'http://127.0.0.1:3101/api/state',reuseExistingServer:false,timeout:30000}
});
