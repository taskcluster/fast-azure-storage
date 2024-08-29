'use strict';

/**
 * The `fast-azure-storage` package provides a fast and minimalistic interface
 * for Azure Storage Service.
 *
 * @module azure
 */

import { Table } from './table.js';
import { Blob } from './blob.js';
import { Queue } from './queue.js';
import { Agent } from './agent.js';

export { Table, Blob, Queue, Agent };
export default { Table, Blob, Queue, Agent };
