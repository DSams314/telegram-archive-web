// One set of operations -- load and save settings, rebuild the index, store a
// picture -- implemented once for each way Telegram Archive can run. Everything
// else in the app calls these and never needs to know which one it is in.

import { MODE } from './mode.js';
import { serverApi } from './server-api.js';
import { webApi } from './web/api.js';

export { MODE };
export const isWeb = MODE === 'web';
export const api = isWeb ? webApi : serverApi;
