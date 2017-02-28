Fast Azure Storage Client for Node.js
=====================================

[![Build Status](https://travis-ci.org/taskcluster/fast-azure-storage.svg?branch=master)](https://travis-ci.org/taskcluster/fast-azure-storage)

This library implements a low-level and highly optimized interface to Azure
Storage Services. Existing node libraries for Azure suffers of excessive
complexity, dependencies, being slow and not managing connection correctly.

At this point this library implement most of the APIs for queue, table and blob
storage. Pull request with additional feature additions will generally be
accepted, as long as patches don't compromise efficiency.

For full documentation see
[reference documentation](https://taskcluster.github.io/fast-azure-storage/)
or extensive comments in the sources.


Common Client Options
---------------------
All three clients, `Queue`, `Table` and `Blob`, take a range of common configuration options.

### Authentication Options
The following example illustrates how to create clients using
**shared key authentication**.
```js
// Load fast-azure-storage client
var azure = require('fast-azure-storage');

// Common options using shared key authentication
var options = {
  accountId:          '...',
  accessKey:          '...'
};

// Create queue, table and blob clients
var queue = new azure.Queue(options);
var table = new azure.Table(options);
var blob  = new azure.Blob(options);
```

It's also possible to configure clients with **Shared-Access-Signatures** as
illustrated in the following example.
```js
// Common options using shared-access-signatures
var options = {
  accountId:          '...',
  sas:                sas   // sas in querystring form: "se=...&sp=...&sig=..."
};
```

In fact it's possible to provide a function that will be used to
**refresh the Shared-Access-Signature** when it's close to expire:
```js
// Common options using shared-access-signatures
var options = {
  accountId:          '...',
  sas:                function() {
    return new Promise(/* fetch SAS from somewhere */);
  },
  // Time to SAS expiration before refreshing the SAS
  minSASAuthExpiry:   15 * 60 * 1000
};
```

### Custom HTTPS Agent Configuration
The fast-azure-storage library comes with a custom `https.Agent` implementation,
optimized for Azure Storage service to reduce latency and avoid errors.
By default,`Blob`,`Table` and `Queue` clients will use a global instance of this
custom agent configured to allow 100 connections per host.

You may override this behavior by supplying your own `agent` as follows.
```js
// Common options for HTTPS agent configuration
var options = {
  agent:      new azure.Agent({...}),
};
```

Please, read the _Built-in Azure HTTPS Agent_ section for details on why this
custom `https.Agent` is necessary. Notice that while it's strongly recommended
to use the HTTPS agent that ships with this library as oppose the default
`https.Agent` implementation, it's perfectly sane to tune the options of the
HTTPS agent that ships with this library, and even create multiple instances of
it if you feel that is necessary.


Azure Table Storage Client
--------------------------
The Azure Storage Table client aims at interfacing Azure Table Storage without
abstracting away the storage format and type information stored with each
entity. It assumes that opinionated abstractions will do type conversions as
necessary.

Simple example of table and entity creation.
```js
// Load fast-azure-storage client
var azure = require('fast-azure-storage');

var table = new azure.Table({
  accountId:    '...',
  accessKey:    '...'
});

// Create table and insert entity
table.createTable('mytable').then(function() {
  return table.insertEntity('mytable', {
    PartitionKey:         '...',
    RowKey:               '...',
    'count':              42,
    'count@odata.type':   'Edm.Int64',
    'buffer':             new Buffer(...).toString('base64'),
    'buffer@odata.type':  'Edm.Binary'
  });
});
```

### Table API Reference

See also [reference documentation](https://taskcluster.github.io/fast-azure-storage/).

 * `Table(options)`
 * `Table#queryTables(options)`
 * `Table#createTable(name)`
 * `Table#deleteTable(name)`
 * `Table#getEntity(table, partitionKey, rowKey, options)`
 * `Table#queryEntities(table, options)`
 * `Table#insertEntity(table, entity)`
 * `Table#updateEntity(table, entity, options)`
 * `Table#deleteEntity(table, partitionKey, rowKey, options)`
 * `Table#sas(table, options)`
 * `Table.filter(expression)`


Azure Queue Storage Client
--------------------------
The Azure Storage Queue client aims at interfacing Azure Queue Storage
and handling all the XML parsing using `libxmljs` if available, if `libxmljs`
isn't available it'll fall-back to use `pixl-xml` which is a pure Javascript,
but also a tiny bit slower.

Simple example of queue and message creation.
```js
// Load fast-azure-storage client
var azure = require('fast-azure-storage');

var queue = new azure.Queue({
  accountId:    '...',
  accessKey:    '...'
});

// Create queue and insert message
queue.createQueue('myqueue').then(function() {
  return queue.putMessage('myqueue', 'my-message', {
    visibilityTimeout:  10,     // Visible after 10 seconds
    messageTTL:         60 * 60 // Expires after 1 hour
  });
});
```

### Queue API Reference

See also [reference documentation](https://taskcluster.github.io/fast-azure-storage/).

 * `Queue(options)`
 * `Queue#listQueues(options)`
 * `Queue#createQueue(name, metadata)`
 * `Queue#deleteQueue(name)`
 * `Queue#getMetadata(queue)`
 * `Queue#setMetadata(queue, metadata)`
 * `Queue#putMessage(queue, text, options)`
 * `Queue#peekMessages(queue, options)`
 * `Queue#getMessages(queue, options)`
 * `Queue#deleteMessage(queue, messageId, popReceipt)`
 * `Queue#clearMessages(queue)`
 * `Queue#updateMessage(queue, text, messageId, popReceipt, options)`
 * `Queue#sas(queue, options)`

Azure Blob Storage Client
--------------------------
The Azure Blob Storage client aims at interfacing Azure Blob Storage.
Using this client, text and binary data can be stored in one of the following types
of blob:
* Block blobs, which are optimized for upload large blobs
* Append blobs, which are optimized for append operations, making it ideal for
eg. logging, auditing

Simple example of a container and blob creation.
```js
// Load fast-azure-storage client
var azure = require('fast-azure-storage');

var blob = new azure.Blob({
  accountId:    '...',
  accessKey:    '...'
});

var blobContent = 'Sample content'; // The content can be a string or a Buffer
// Create container and upload a blob
blob.createContainer('mycontainer').then(function() {
  return blob.putBlob('mycontainer', 'myblob', {
    type:  'BlockBlob',     // Type of the blob 
  }, blobContent);
});
```

### Blob API Reference

See also [reference documentation](https://taskcluster.github.io/fast-azure-storage/).

 * `Blob(options)`
 * `Blob#setServiceProperties(options)`
 * `Blob#getServiceProperties()`
 * `Blob#createContainer(name, options)`
 * `Blob#setContainerMetadata(name, metadata, options)`
 * `Blob#getContainerMetadata(name, options)`
 * `Blob#deleteContainer(name, options)`
 * `Blob#listContainers(options)`
 * `Blob#getContainerProperties(name, options)`
 * `Blob#getContainerACL(name, options)`
 * `Blob#setContainerACL(name, options)`
 * `Blob#listBlobs(container, options)`
 * `Blob#leaseContainer(name, options)`
 * `Blob#putBlob(container, blob, options, content)`
 * `Blob#getBlob(container, blob, options)`
 * `Blob#getBlobProperties(container, blob, options)`
 * `Blob#setBlobProperties(container, blob, options)`
 * `Blob#getBlobMetadata(container, blob, options)`
 * `Blob#setBlobMetadata(container, blob, metadata, options)`
 * `Blob#deleteBlob(container, blob, options)`
 * `Blob#putBlock(container, blob, options, content)`
 * `Blob#putBlockList(container, blob, options)`
 * `Blob#getBlockList(container, blob, options)`
 * `Blob#getBlockId(prefix, blockNumber, length)`
 * `Blob#appendBlock(container, blob, options, content)`
 * `Blob#sas(container, blob, options)`