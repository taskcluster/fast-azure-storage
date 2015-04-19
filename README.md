Fast Azure Storage Client for Node.js
=====================================

This library implements a low-level and highly optimized interface to Azure
Storage Services. Existing node libraries for Azure suffers of excessive
complexity, dependencies, being slow and not managing connection correctly.

At this point this library implement most of the APIs for queue and table
storage. Pull request with additional feature additions will generally be
accepted, as long as patches don't compromise efficiency.

For full documentation see [reference documentation](TODO ADD DOCS LINK HERE)
or extensive comments in the sources.

Common Client Options
---------------------


{accountId, accessKey}
{accountId, sas: function() {...}, timeout: ...}


Table Storage Reference
-----------------------
new Table(options)
Table#queryTables(options)
Table#createTable(name)
Table#deleteTable(name)
Table#getEntity(table, pk, rk, options)
Table#queryEntities(table, options)
Table#insertEntity(table, entity)
Table#updateEntity(table, partitionKey, rowKey, entity, options)
Table#deleteEntity(table, partitionKey, rowKey, options)
Table.sas(table, options)
Table.filter([/* Expression combining Table.Operators */])



Queue Client Reference
----------------------

Queue({accountId, accessKey})

