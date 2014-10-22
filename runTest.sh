#!/bin/bash

./prepareES5.sh
6to5 --source-maps-inline test.js > test-es5.js
node test-es5.js
rm test-es5.js