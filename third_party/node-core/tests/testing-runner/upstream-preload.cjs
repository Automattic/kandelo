'use strict';
if (process.env.KANDELO_TEST_SUBJECT === 'candidate') require('./platform.cjs')(require('node:path').resolve(__dirname, '../../../..'));
