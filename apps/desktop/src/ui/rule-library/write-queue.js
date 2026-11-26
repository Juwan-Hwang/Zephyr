// @ts-check
import { createSerialQueue } from '../../utils/sequential.js';

/** Rule cards and the library share one read/write turn. */
const writes = createSerialQueue();
export const queueRuleWrite = writes.run;
