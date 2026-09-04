import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir:'test', testMatch:'*.spec.js', workers:1,
  use:{headless:true, viewport:{width:1280,height:850},
    ...(process.env.SIXTONET_TEST_BROWSER ? {channel:process.env.SIXTONET_TEST_BROWSER} : {})},
});
