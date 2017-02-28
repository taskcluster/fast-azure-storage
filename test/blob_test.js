suite("Azure Blob", function() {
  var azure   = require('../');
  var assert  = require('assert');
  var utils   = require('../lib/utils');

  // Create azure blob client
  var blob = new azure.Blob({
    accountId: process.env.AZURE_STORAGE_ACCOUNT,
    accessKey: process.env.AZURE_STORAGE_ACCESS_KEY
  });

  var anonymousBlob = new azure.Blob({
    accountId: process.env.AZURE_STORAGE_ACCOUNT,
    accountKey: null
  });

  var containerNamePrefix = 'fast-azure-blob-container';
  var date15MinAgo = new Date(Date.now() - 15 * 60 * 1000);
  var options = null;
  var containerName = null;

  suite('Service', function () {
    test('get service properties', function () {
      return blob.getSeviceProperties().then(function (response) {
        assert(response.logging);
        assert(response.hourMetrics);
        assert(response.minuteMetrics);
        assert(response.corsRules);
      })
    });

    test('set service properties', function() {
      return blob.setServiceProperties({
        logging: {
          version: 1,
          delete: true,
          read: true,
          write: true,
          retentionPolicy: {
            enabled: true,
            days: 80
          }
        },
        hourMetrics:
          { version: 1,
            enabled: false,
            retentionPolicy: { enabled: false } },
        minuteMetrics:
          { version: 1,
            enabled: true,
            includeAPIs: false,
            retentionPolicy: { enabled: true, days: 1 } },
        corsRules:
          [ { allowedOrigins: ['*'],
            allowedMethods: ['POST'],
            maxAgeInSeconds: 300,
            exposedHeaders: ['content-length'],
            allowedHeaders: [] } ]
      }).then(function () {
        return blob.getSeviceProperties();
      }).then(function (response) {
        assert(response.logging.version === '1.0');
        assert(response.logging.delete === 'true');
        assert(response.logging.read === 'true');
        assert(response.logging.write === 'true');
        assert(response.logging.retentionPolicy.days === '80');

        assert(response.hourMetrics.enabled === 'false');
        assert(response.hourMetrics.retentionPolicy.enabled === 'false');

        assert(response.minuteMetrics.enabled === 'true');
        assert(response.minuteMetrics.includeAPIs === 'false');
        assert(response.minuteMetrics.retentionPolicy.enabled === 'true');
        assert(response.minuteMetrics.retentionPolicy.days === '1');

        assert(response.corsRules.length === 1);
        assert(response.corsRules[0].allowedMethods === 'POST');
        assert(response.corsRules[0].exposedHeaders === 'content-length');
      })
    });
  });

  suite("Container", function() {
    test('create container with metadata', function() {
      containerName = containerNamePrefix + '-with-metadata';
      options = {
        metadata: {
          testKey: 'testValue'
        }
      };

      return blob.createContainer(containerName, options);
    });

    test('create container without metadata', function() {
      containerName = containerNamePrefix + '-without-metadata';

      return blob.createContainer(containerName, {});
    });

    test('create container with container access and check if the access level is correctly set', function() {
      containerName = containerNamePrefix + '-with-access';

      return blob.createContainer(containerName, { publicAccessLevel: 'container' }).then(function(){
        /* If the publicAccessLevel is `container`, clients can call:
         getContainerProperties, getContainerMetadata, listBlobs anonymously
         */
        return anonymousBlob.getContainerProperties(containerName);
      }).then(function(result){
        assert(result.properties.eTag);
        assert(result.properties.lastModified);
        assert(result.properties.leaseStatus);
        assert(result.properties.leaseState);
        assert(result.properties.publicAccessLevel === 'container');
      });
    });

    test('set and get container metadata', function() {
      containerName = containerNamePrefix + '-set-get-metadata';

      // create a container without metadata
      return blob.createContainer(containerName, {}).then(function(){
        // set metadata to newly created container
        var metadata = { appName: 'fast-azure-storage' };
        return blob.setContainerMetadata(containerName, metadata);
      }).then(function(){
        return blob.getContainerMetadata(containerName);
      }).then(function(result){
        // verify if the metadata was correctly set
        assert(result.metadata.appName === 'fast-azure-storage');
      });
    });

    test('list containers with prefix', function() {
      return blob.listContainers({ prefix: containerNamePrefix }).then(function(result){
        assert(result.containers.length > 0);
      });
    });

    test('list containers with prefix and metadata', function() {
      options = {
        prefix: containerNamePrefix,
        metadata: true
      };
      return blob.listContainers(options).then(function(result){
        assert(result.containers.length > 0);
        var myContainer = null;
        result.containers.forEach(function(container) {
          if (container.name ===  containerNamePrefix + '-with-metadata') {
            myContainer = container;
          }
        });
        assert(myContainer, "Expected to find the 'fast-azure-blob-container-with-metadata'");
        assert(myContainer.metadata.testKey === 'testValue');
      });
    });

    test('list containers with metadata', function() {
      return blob.listContainers({ metadata: true }).then(function(result){
        assert(result.containers.length > 0);
      });
    });

    test('get container properties', function(){
      containerName = containerNamePrefix + '-with-properties';
      options = {
        metadata : {
          appName: 'fast-azure-storage'
        }
      };
      return blob.createContainer(containerName, options).then(function(){
        return blob.getContainerProperties(containerName);
      }).then(function(result){
        assert(result.metadata.appName === 'fast-azure-storage');
        var props = result.properties;
        assert(props.eTag);
        assert(props.lastModified);
        assert(props.leaseStatus);
        assert(props.leaseState);
      });
    });

    test('get container (with access level, without metadata) properties', function(){
      containerName = containerNamePrefix + '-with-access';
      return blob.getContainerProperties(containerName).then(function(result){
        var props = result.properties;
        assert(props.eTag);
        assert(props.lastModified);
        assert(props.leaseStatus);
        assert(props.leaseState);
        assert(props.publicAccessLevel === 'container');
      });
    });

    test('set, get container ACL', function(){
      containerName = containerNamePrefix + '-with-acl';

      return blob.createContainer(containerName, {}).then(function(){
        var accessPolicies = [
          {
            id: 1,
            start: date15MinAgo,
            permission: {
              read: true,
              add: true,
              create: true,
              write: true,
              list: true,
            }
          },
          {
            id: 2,
            start: date15MinAgo,
            permission: {
              list: false,
            }
          }
        ];
        options = {
          publicAccessLevel: 'container',
          accessPolicies: accessPolicies
        }
        return blob.setContainerACL(containerName, options);
      }).then(function(){
        return blob.getContainerACL(containerName);
      }).then(function (result) {
        assert(result.publicAccessLevel === 'container');
        assert(result.accessPolicies.length === 2);

        var ap0 = result.accessPolicies[0];
        assert(ap0.id === '1');
        assert(ap0.permission.read === true);
        assert(ap0.permission.list === true);
        assert(ap0.permission.delete === false);
        assert(ap0.permission.add === true);
        assert(ap0.permission.create === true);
        assert(ap0.permission.write === true);

        var ap1 = result.accessPolicies[1];
        assert(ap1.id === '2');
        assert(ap1.permission.read === false);
        assert(ap1.permission.list === false);
        assert(ap1.permission.delete === false);
        assert(ap1.permission.add === false);
        assert(ap1.permission.create === false);
        assert(ap1.permission.write === false);
      });
    });

    test('set container ACL with if-modified-since and if-unmodified-since', function () {
      containerName = containerNamePrefix + '-with-acl-conditional-headers';

      return blob.createContainer(containerName)
        .then(function () {
          options = {
            publicAccessLevel: 'container',
            ifModifiedSince: date15MinAgo
          };
          return blob.setContainerACL(containerName, options);
        }).then(function (result) {
          assert(result.eTag);
          assert(result.lastModified);

          options = {
            publicAccessLevel: 'blob',
            ifUnmodifiedSince: date15MinAgo
          };
          return blob.setContainerACL(containerName, options);
        }).catch(function (error) {
          assert(error.code === 'ConditionNotMet');
          assert(error.statusCode === 412);
        });
    });

    test('Shared-Access-Signature (with access policy which has list permission)', function(){
      containerName = containerNamePrefix + '-with-acl';
      var sas = blob.sas(containerName, null, {
        expiry:   new Date(Date.now() + 30 * 60 * 1000),
        resourceType: 'container',
        accessPolicy: 1
      });
      var blobWithSas = new azure.Blob({
        accountId:    blob.options.accountId,
        sas:          sas
      });
      return blobWithSas.listBlobs(containerName, {});
    });

    test('Shared-Access-Signature (with access policy with forbid list)', function(){
      containerName = containerNamePrefix + '-with-acl';
      var sas = blob.sas(containerName, null, {
        expiry: new Date(Date.now() + 30 * 60 * 1000),
        resourceType: 'container',
        accessPolicy: 2
      });
      var blobWithSas = new azure.Blob({
        accountId:    blob.options.accountId,
        sas:          sas
      });
      return blobWithSas.listBlobs(containerName, {}).catch(function(err){
        // Returns AuthorizationFailed (403). I think it should return AuthorizationPermissionMismatch (403)
        // assert(err.code === 'AuthorizationPermissionMismatch');
        assert(err.statusCode === 403);
      });
    });

    test('Shared-Access-Signature (forbid list blobs)', function(){
      containerName = containerNamePrefix + '-with-metadata';
      var sas = blob.sas(containerName, null, {
        start:    date15MinAgo,
        expiry:   new Date(Date.now() + 30 * 60 * 1000),
        resourceType: 'container',
        permissions: {
          read: true,
          add: false,
          create: false,
          write: false,
          delete: false,
          list: false
        }
      });
      var blobWithSas = new azure.Blob({
        accountId:    blob.options.accountId,
        sas:          sas
      });
      return blobWithSas.listBlobs(containerName, {}).catch(function(err) {
        // Should return AuthorizationPermissionMismatch (403)
        assert(err.code === 'AuthorizationPermissionMismatch');
        assert(err.statusCode === 403);
      });
    });

    test('Shared-Access-Signature (forbid create a container - only the owner can create a container)', function() {
      containerName = containerNamePrefix + '-shared-key';
      var sas = blob.sas(containerName, null, {
        start:    date15MinAgo,
        expiry:   new Date(Date.now() + 30 * 60 * 1000),
        resourceType: 'container',
        permissions: {
          read: true,
          add: true,
          create: true,
          write: true,
          delete: true,
          list: true
        }
      });

      var blobWithSas = new azure.Blob({
        accountId: blob.options.accountId,
        sas: sas
      });

      return blobWithSas.createContainer(containerName, {}).catch(function(err) {
        // only the account owner can initiate a create container request
        assert(err.statusCode === 403);
        assert(err.code === 'AuthorizationFailure');
      });
    });

    test('Shared-Access-Signature (forbid read properties of a container - only the owner can do this)', function() {
      containerName = containerNamePrefix + '-with-metadata';
      var sas = blob.sas(containerName, null, {
        start:    date15MinAgo,
        expiry:   new Date(Date.now() + 30 * 60 * 1000),
        resourceType: 'container',
        permissions: {
          read: true,
          add: true,
          create: true,
          write: true,
          delete: true,
          list: true
        }
      });

      var blobWithSas = new azure.Blob({
        accountId: blob.options.accountId,
        sas: sas
      });

      return blobWithSas.getContainerProperties(containerName, {}).catch(function(err) {
        // only the account owner can initiate a create container request
        assert(err.statusCode === 403);
      });
    });

    test("Shared-Access-Signature (will refresh)", function() {
      containerName = containerNamePrefix + '-with-metadata';
      var refreshCount = 0;
      var refreshSAS = function() {
        refreshCount += 1;
        return blob.sas(containerName, null, {
          expiry:   new Date(Date.now() + 15 * 60 * 1000 + 100),
          resourceType: 'container',
          permissions: {
            read: true,
            add: true,
            create: true,
            write: true,
            delete: true,
            list: true
          }
        });
      };
      var blobWithSas = new azure.Blob({
        accountId:        blob.options.accountId,
        sas:              refreshSAS,
        minSASAuthExpiry: 15 * 60 * 1000
      });
      return blobWithSas.listBlobs(containerName, {}).then(function() {
        assert(refreshCount === 1);
        return utils.sleep(200);
      }).then(function() {
        return blobWithSas.listBlobs(containerName, {});
      }).then(function() {
        assert(refreshCount === 2);
      });
    });

    test("Shared-Access-Signature (won't refresh on every call)", function() {
      containerName = containerNamePrefix + '-with-metadata';
      var refreshCount = 0;
      var refreshSAS = function() {
        refreshCount += 1;
        return blob.sas(containerName, null, {
          expiry: new Date(Date.now() + 20 * 60 * 1000),
          resourceType: 'container',
          permissions: {
            read: true,
            add: true,
            create: true,
            write: true,
            delete: true,
            list: true
          }
        });
      };
      var blobWithSas = new azure.Blob({
        accountId:        blob.options.accountId,
        sas:              refreshSAS,
        minSASAuthExpiry: 15 * 60 * 1000
      });
      return blobWithSas.listBlobs(containerName, {}).then(function() {
        assert(refreshCount === 1);
        return utils.sleep(200);
      }).then(function() {
        return blobWithSas.listBlobs(containerName, {});
      }).then(function() {
        assert(refreshCount === 1);
      });
    });

    test("Retries up to 5 times", function() {
      containerName = containerNamePrefix + '-with-metadata';
      var request = utils.request;
      var requestCount = 0;
      utils.request = function() {
        requestCount += 1;
        return utils.sleep(100).then(function() {
          var err = new Error('ECONNRESET');
          err.code = 'ECONNRESET';
          throw err;
        });
      };
      return blob.listBlobs(containerName, {}).then(function() {
        utils.request = request;
        assert(false, "Expected an error");
      }, function(err) {
        utils.request = request;
        assert(err.code === 'ECONNRESET');
        assert(requestCount === 6, "Expected 1 request + 5 retries");
      });
    });


    test('acquire a lease for a container, forbid delete container and release the lease', function(){
      containerName = containerNamePrefix + '-with-lease';
      return blob.createContainer(containerName).then(function(){
        var leaseOptions = {
          leaseAction: 'acquire',
          leaseDuration: 15
        };
        var leaseId = null;
        return blob.leaseContainer(containerName,leaseOptions).then(function(result){
          leaseId = result.leaseId;
          assert(leaseId);
          return blob.deleteContainer(containerName);
        }).catch(function(err){
          assert(err.statusCode === 412);
          options = {
            leaseAction: 'release',
            leaseId: leaseId
          };
          return blob.leaseContainer(containerName, options);
        });
      });
    });

    test('acquire a lease for a container with if-modified-since and if-unmodified-since conditional header', function () {
      containerName = containerNamePrefix + '-conditional-header';
      return blob.createContainer(containerName).then(function (result) {
        assert(result.eTag);
        assert(result.lastModified);

        options = {
          leaseAction: 'acquire',
          leaseDuration: 15,
          ifUnmodifiedSince: date15MinAgo
        };

        return blob.leaseContainer(containerName, options);
      }).catch(function (error) {
        assert(error.code === 'ConditionNotMet');
        assert(error.statusCode === 412);

        options = {
          leaseAction: 'acquire',
          leaseDuration: 15,
          ifModifiedSince: date15MinAgo
        };
        return blob.leaseContainer(containerName, options);
      }).then(function (result) {
        assert(result.leaseId);
        assert(result.eTag);
        assert(result.lastModified);

        options = {
          leaseAction: 'release',
          leaseId: result.leaseId
        };
        return blob.leaseContainer(containerName, options);
      });
    });

    test('delete container with if-modified-since conditional header', function () {
      containerName = containerNamePrefix + '-delete-with-condition';
      return blob.createContainer(containerName).then(function (result) {
        assert(result.eTag);
        assert(result.lastModified);

        return utils.sleep(1000);
      }).then(function () {
        return blob.deleteContainer(containerName, {ifModifiedSince: new Date(Date.now())})
      }).catch(function (error) {
        assert(error.code === 'ConditionNotMet');
        assert(error.statusCode === 412);

        return blob.setContainerMetadata(containerName, {scope: 'test'});
      }).then(function (result) {
        assert(result.eTag);
        assert(result.lastModified);

        return blob.deleteContainer(containerName, {ifModifiedSince: date15MinAgo});
      });
    });

    test('delete container with if-unmodified-since conditional header', function () {
      containerName = containerNamePrefix + '-delete-with-condition2';
      return blob.createContainer(containerName).then(function (result) {
        assert(result.eTag);
        assert(result.lastModified);

        return blob.deleteContainer(containerName, {ifUnmodifiedSince: date15MinAgo})
      }).catch(function (error) {
        assert(error.code === 'ConditionNotMet');
        assert(error.statusCode === 412);
      });
    });

    test('set container metadata with if-modified-since conditional header', function () {
      containerName = containerNamePrefix + '-set-metadata-conditional-header';
      return blob.createContainer(containerName).then(function (result) {
        assert(result.eTag);
        assert(result.lastModified);

        return blob.setContainerMetadata(containerName, {scope: 'test'}, {ifModifiedSince: date15MinAgo});
      }).then(function (result) {
        return blob.setContainerMetadata(containerName, {scope: 'test2'}, {ifModifiedSince: new Date(Date.now())});
      }).catch(function (error) {
        assert(error.code === 'ConditionNotMet');
        assert(error.statusCode === 412);
      });
    });
  });
  suite("Blob", function() {
    var containerName = containerNamePrefix + '-with-blobs';
    var blockBlobName = 'blobTest';
    var appendBlobName = 'appendBlobTest';
    var tempBlockBlobNamePrefix = 'tempBlockBlob';
    var blobName = null;

    suiteSetup(function() {
      return blob.createContainer(containerName);
    });

    test('put text block blob', function(){
      var content = 'hello world';
      return blob.putBlob(containerName, blockBlobName, { type: 'BlockBlob' }, content);
    });

    test('get text block blob', function(){
      return blob.getBlob(containerName, blockBlobName).then(function(result){
        assert(result.content === 'hello world');
      });
    });

    test('set and get blob metadata', function() {
      var metadata = {
        origin: 'taskcluster'
      };
      return blob.setBlobMetadata(containerName, blockBlobName, metadata).then(function() {
        return blob.getBlobMetadata(containerName, blockBlobName);
      }).then(function(result){
        assert(result.metadata.origin === 'taskcluster');
      });
    });

    test('set and get blob properties', function() {
      options = {
        cacheControl: 'no-cache',
        contentType: 'text/plain;charset="utf8"',
        contentEncoding: 'gzip',
        contentLanguage: 'en-US',
        contentDisposition: 'attachment; filename="file.txt"'
      };

      return blob.setBlobProperties(containerName, blockBlobName, options).then(function() {
        return blob.getBlobProperties(containerName, blockBlobName);
      }).then(function(result) {
        assert(result.type === 'BlockBlob');
        assert(result.contentLength === '11');
        assert(result.contentType === 'text/plain;charset="utf8"');
        assert(result.contentEncoding === 'gzip');
        assert(result.contentLanguage === 'en-US');
        assert(result.contentDisposition === 'attachment; filename="file.txt"');
        assert(result.metadata.origin === 'taskcluster');
      });
    });

    test('put block, getBlockList and putBlockList', function () {
      var blockContent1 = new Buffer("Lorem Ipsum is simply dummy text of the printing and typesetting industry. " +
        "Lorem Ipsum has been the industry's standard dummy text ever since the 1500s, when an unknown printer took a" +
        " galley of type and scrambled it to make a type specimen book. It has survived not only five centuries, but also" +
        " the leap into electronic typesetting, remaining essentially unchanged. It was popularised in the 1960s with the " +
        "release of Letraset sheets containing Lorem Ipsum passages, and more recently with desktop publishing software like Aldus PageMaker including versions of Lorem Ipsum.");
      var blockId1 = blob.getBlockId('fastazure', 1, 3);

      var blockContent2 = 'Contrary to popular belief, Lorem Ipsum is not simply random text. It has roots in a piece of classical Latin literature from 45 BC, making it over 2000 years old.';
      var blockId2 = blob.getBlockId('fastazure', 2, 3);

      // put a new block to a block blob
      return blob.putBlock(containerName, blockBlobName, { blockId: blockId1 }, blockContent1).then(function () {
        return blob.getBlockList(containerName, blockBlobName, { blockListType: 'all' });
      }).then(function (result) {
        // verify that the block list contains an uncommitted block
        assert(result.uncommittedBlocks.length === 1);
        assert(result.uncommittedBlocks[0].blockId === blockId1);
        assert(result.committedBlocks.length === 0);

        // commit the block uploaded
        return blob.putBlockList(containerName, blockBlobName, { uncommittedBlockIds: [result.uncommittedBlocks[0].blockId] });
      }).then(function () {
        return blob.getBlob(containerName, blockBlobName);
      }).then(function (result) {
        // verify the commit of the block
        assert(result.content === blockContent1.toString());

        // commit another block
        return blob.putBlock(containerName, blockBlobName, { blockId: blockId2 }, blockContent2);
      }).then(function () {
        // verify that the block list contains an uncommitted block and a committed block
        return blob.getBlockList(containerName, blockBlobName, { blockListType: 'all' });
      }).then(function(result) {
        assert(result.uncommittedBlocks.length === 1);
        assert(result.uncommittedBlocks[0].blockId === blockId2);
        assert(result.committedBlocks.length === 1);

        options = {
          committedBlockIds: [result.committedBlocks[0].blockId],
          uncommittedBlockIds: [result.uncommittedBlocks[0].blockId]
        };

        return blob.putBlockList(containerName, blockBlobName, options);
      }).then(function (result) {
        return blob.getBlob(containerName, blockBlobName);
      }).then(function (result) {
        // verify that the blob is updated
        assert(result.content === (blockContent1.toString() + blockContent2));
      });
    });

    test('create append blob', function() {
      return blob.putBlob(containerName, appendBlobName, { type: 'AppendBlob' });
    });

    test('append block blob', function () {
      blobName = 'AppendBlob';
      var content = new Buffer("Lorem Ipsum is simply dummy text of the printing and typesetting industry. " +
        "Lorem Ipsum has been the industry's standard dummy text ever since the 1500s, when an unknown printer took a" +
        " galley of type and scrambled it to make a type specimen book. It has survived not only five centuries, but also" +
        " the leap into electronic typesetting, remaining essentially unchanged. It was popularised in the 1960s with the " +
        "release of Letraset sheets containing Lorem Ipsum passages, and more recently with desktop publishing software like Aldus PageMaker including versions of Lorem Ipsum.");

      return blob.appendBlock(containerName, appendBlobName, {}, content).then(function (result) {
        assert(result.committedBlockCount === '1');
      });
    });

    test('delete blob', function () {
      return blob.deleteBlob(containerName, blockBlobName);
    });

    test('delete blob with if-match conditional header', function(){
      blobName = tempBlockBlobNamePrefix + '_if_match_conditional_header';
      return blob.putBlob(containerName, blobName, {type: 'BlockBlob'}, 'Hello world').then(function (result) {
        assert(result.eTag);

        return blob.deleteBlob(containerName, blobName, { ifMatch: result.eTag });
      });
    });

    test('delete blob with if-non-match conditional header', function () {
      blobName = tempBlockBlobNamePrefix + '_if_none_matching_conditional_header';
      return blob.putBlob(containerName, blobName, {type: 'BlockBlob'}, 'Hello world').then(function (result) {
        assert(result.eTag);

        return blob.deleteBlob(containerName, blobName, { ifNoneMatch: result.eTag });
      }).catch(function (error){
        assert(error.code === 'ConditionNotMet');
        assert(error.statusCode === 412);
      })
    });

    test('delete blob with if-modified-since conditional header', function (){
      blobName = tempBlockBlobNamePrefix + '_if_modified_since_conditional_header';

      return blob.putBlob(containerName, blobName, {type: 'BlockBlob'}, 'Hello world').then(function (result) {
        return blob.setBlobMetadata(containerName, blobName, {scope: 'test'})
      }).then(function (result) {
        assert(result.lastModified);
        assert(result.eTag);

        return blob.deleteBlob(containerName, blobName, { ifModifiedSince: date15MinAgo });
      });
    });

    test('delete blob with if-unmodified-since conditional header', function () {
      blobName = tempBlockBlobNamePrefix + '_if_unmodified_since_conditional_header';

      return blob.putBlob(containerName, blobName, {type: 'BlockBlob'}, 'Hello world').then(function (result) {
        return blob.setBlobMetadata(containerName, blobName, {scope: 'test'})
      }).then(function (result) {
        assert(result.lastModified);
        assert(result.eTag);

        return blob.deleteBlob(containerName, blobName, { ifUnmodifiedSince: new Date(Date.now()) });
      }).catch(function (error) {
        assert(error.code === 'ConditionNotMet');
        assert(error.statusCode === 412);
      });
    });

    test('get blob with if-match conditional header', function () {
      blobName = tempBlockBlobNamePrefix + 'get_blob_if_match_conditional_header';

      return blob.putBlob(containerName, blobName, {type: 'BlockBlob'}, 'Hello world').then(function (result) {
        assert(result.eTag);

        return blob.getBlob(containerName, blobName, { ifMatch: result.eTag });
      });
    });

    test('get blob with if-none-match conditional header', function () {
      blobName = tempBlockBlobNamePrefix + 'get_blob_if_none_match_conditional_header';
      return blob.putBlob(containerName, blobName, {type: 'BlockBlob'}, 'Hello world').then(function (result) {
        return blob.setBlobProperties(containerName, blobName, {contentType: 'text/plain; charset="utf8"'})
      }).then(function (result) {
        assert(result.eTag);
        assert(result.lastModified);

        return blob.getBlob(containerName, blobName, { ifNoneMatch: result.eTag });
      }).catch(function (error) {
        assert(error.statusCode === 304);
      });
    });

    test('get blob with if-modified-since conditional header', function () {
      blobName = tempBlockBlobNamePrefix + 'get_blob_if_modified_since_conditional_header';
      var blockId = blob.getBlockId('fastazure', 1, 2);
      return blob.putBlob(containerName, blobName, {type: 'BlockBlob'}).then(function () {
        return blob.putBlock(containerName, blobName, {blockId: blockId}, 'hello world');
      }).then(function () {
        return blob.putBlockList(containerName, blobName, {uncommittedBlockIds:[blockId]});
      }).then(function (result) {
        assert(result.eTag);
        assert(result.lastModified);

        return blob.getBlob(containerName, blobName, { ifModifiedSince: date15MinAgo });
      });
    });

    test('get blob with if-unmodified-since conditional header', function () {
      blobName = tempBlockBlobNamePrefix + 'get_blob_if_unmodified_since_conditional_header';
      return blob.putBlob(containerName, blobName, {type: 'BlockBlob'}).then(function () {
        return blob.setBlobMetadata(containerName, blobName, {scope: 'test'});
      }).then(function (result) {
        assert(result.lastModified);
        return blob.getBlob(containerName, blobName, {ifUnmodifiedSince: result.lastModified});
      })
    });

    test('get blob metadata with if-modified-since, if-unmodified-since, if-match and if-none-match conditional header', function () {
      blobName = tempBlockBlobNamePrefix + '_with_metadata';
      return blob.putBlob(containerName, blobName, {type: 'AppendBlob'}).then(function () {
        return blob.setBlobMetadata(containerName, blobName, {appName: 'fast-azure'});
      }).then(function (result) {
        assert(result.eTag);
        return blob.getBlobMetadata(containerName, blobName, {ifMatch: result.eTag});
      }).then(function (result) {
        assert(result.metadata.appName === 'fast-azure');

        return blob.getBlobMetadata(containerName, blobName, {ifNoneMatch: result.eTag});
      }).catch(function (error) {
        // result code if condition has not been met it should be 'Not modified(304)'
        assert(error.statusCode === 304);

        return blob.getBlobMetadata(containerName, blobName, { ifModifiedSince: date15MinAgo });
      }).then(function (result) {
        assert(result.lastModified);

        return blob.getBlobMetadata(containerName, blobName, { ifUnmodifiedSince: date15MinAgo });
      }).catch(function (error) {
        assert(error.statusCode === 412);
      });
    });

    test('get blob properties with if-modified-since, if-unmodified-since, if-match and if-none-match conditional header', function () {
      blobName = tempBlockBlobNamePrefix + '_with_properties';

      return blob.putBlob(containerName, blobName, {type: 'BlockBlob'}).then(function () {
        return blob.setBlobProperties(containerName, blobName, {contentLanguage: 'en-EN'});
      }).then(function (result) {
        assert(result.eTag);

        return blob.getBlobProperties(containerName, blobName, {ifMatch: result.eTag});
      }).then(function (result) {
        assert(result.contentLanguage === 'en-EN');

        return blob.getBlobProperties(containerName, blobName, {ifNoneMatch: result.eTag});
      }).catch(function (error) {
        assert(error.statusCode === 304);

        return blob.getBlobProperties(containerName, blobName, {
          ifModifiedSince: date15MinAgo
        });
      }).then(function (result) {
        assert(result.lastModified);

        return blob.getBlobProperties(containerName, blobName, { ifUnmodifiedSince: date15MinAgo });
      }).catch(function (error) {
        assert(error.statusCode === 412);
      });
    });

    test('set blob metadata with if-modified-since, if-unmodified-since, if-match and if-none-match conditional header', function () {
      blobName = tempBlockBlobNamePrefix + '_with_metadata_conditional_headers';
      return blob.putBlob(containerName, blobName, {type: 'BlockBlob'}).then(function (result) {
        assert(result.lastModified);
        assert(result.eTag);
        return blob.setBlobMetadata(containerName, blobName, {application: 'azure'}, {ifMatch: result.eTag});
      }).then(function (result) {
        assert(result.eTag);
        assert(result.lastModified);

        return blob.setBlobMetadata(containerName, blobName, {scope: 'test'}, {ifNoneMatch: result.eTag});
      }).catch(function (error) {
        assert(error.code === 'ConditionNotMet');
        assert(error.statusCode === 412);

        return blob.setBlobMetadata(containerName, blobName, {scope: 'test'}, { ifModifiedSince: new Date(Date.now()) });
      }).then(function (result) {
        assert(result.eTag);
        assert(result.lastModified);

        return blob.setBlobMetadata(containerName, blobName, {scope: 'test'}, { ifUnmodifiedSince: date15MinAgo });
      }).catch(function (error) {
        assert(error.code === 'ConditionNotMet');
        assert(error.statusCode === 412);
      });
    });

    test('set blob properties with if-modified-since, if-unmodified-since, if-match and if-none-match conditional header', function () {
      blobName = tempBlockBlobNamePrefix + '_with_props_conditional_headers';
      return blob.putBlob(containerName, blobName, {type: 'BlockBlob'}).then(function (result) {
        assert(result.lastModified);
        assert(result.eTag);
        return blob.setBlobProperties(containerName, blobName, {contentEncoding: 'gzip'}, {ifMatch: result.eTag});
      }).then(function (result) {
        assert(result.eTag);
        assert(result.lastModified);

        return blob.setBlobProperties(containerName, blobName, {contentEncoding: 'gzip'}, {ifNoneMatch: result.eTag});
      }).catch(function (error) {
        assert(error.code === 'ConditionNotMet');
        assert(error.statusCode === 412);

        return blob.setBlobProperties(containerName, blobName, {contentEncoding: 'gzip'}, { ifModifiedSince: new Date(Date.now()) });
      }).then(function (result) {
        assert(result.eTag);
        assert(result.lastModified);

        return blob.setBlobProperties(containerName, blobName, {contentEncoding: 'gzip'}, { ifUnmodifiedSince: date15MinAgo });
      }).catch(function (error) {
        assert(error.code === 'ConditionNotMet');
        assert(error.statusCode === 412);
      });
    });

    test('put blob with if-modified-since, if-unmodified-since, if-match and if-none-match conditional header', function () {
      blobName = tempBlockBlobNamePrefix + '_put_blob_with_conditional_headers';
      return blob.putBlob(containerName, blobName, {type: 'BlockBlob'}).then(function (result) {
        assert(result.lastModified);
        assert(result.eTag);

        return blob.putBlob(containerName, blobName, {
          type: 'BlockBlob',
          ifMatch: result.eTag
        }, 'hello world');
      }).then(function (result) {
        assert(result.lastModified);
        assert(result.eTag);

        return blob.putBlob(containerName, blobName, {
          type: 'BlockBlob',
          ifNoneMatch: result.eTag
        }, 'hello again');
      }).catch(function (error) {
        assert(error.code === 'ConditionNotMet');
        assert(error.statusCode === 412);

        return blob.putBlob(containerName, blobName, {
          type: 'BlockBlob',
          ifModifiedSince: new Date(Date.now())
        }, 'hello from error');
      }).then(function (result) {
        assert(result.eTag);
        assert(result.lastModified);

        blob.putBlob(containerName, blobName, {
          type: 'BlockBlob',
          ifUnmodifiedSince: date15MinAgo
        }, 'hello from error');
      }).catch(function (error) {
        assert(error.code === 'ConditionNotMet');
        assert(error.statusCode === 412);
      });
    });

    test('append block with if-modified-since, if-unmodified-since, if-match and if-none-match conditional header', function () {
      blobName = tempBlockBlobNamePrefix + '_append_block_with_conditional_headers';
      return blob.putBlob(containerName, blobName, {type: 'AppendBlob'}).then(function (result) {
        assert(result.lastModified);
        assert(result.eTag);
        return blob.appendBlock(containerName, blobName, { ifMatch: result.eTag }, 'log1');
      }).then(function (result) {
        assert(result.lastModified);
        assert(result.eTag);
        return blob.appendBlock(containerName, blobName, { ifNoneMatch: result.eTag }, 'log2');
      }).catch(function (error) {
        assert(error.code === 'ConditionNotMet');
        assert(error.statusCode === 412);

        return blob.appendBlock(containerName, blobName, { ifModifiedSince: new Date(Date.now()) }, 'log3');
      }).then(function (result) {
        assert(result.eTag);
        assert(result.lastModified);

        blob.appendBlock(containerName, blobName, { ifUnmodifiedSince: date15MinAgo }, 'log4');
      }).catch(function (error) {
        assert(error.code === 'ConditionNotMet');
        assert(error.statusCode === 412);
      });
    });

    test('putBlockList with if-modified-since, if-unmodified-since, if-match and if-none-match conditional header', function () {
      blobName = tempBlockBlobNamePrefix + '_put_block_list_with_conditional_headers';
      var blockId1 = blob.getBlockId('fastazure', 1, 1);
      var blockId2 = blob.getBlockId('fastazure', 2, 1);
      var eTag = null;
      return blob.putBlob(containerName, blobName, { type: 'BlockBlob' }).then(function (result) {
        assert(result.eTag);
        eTag = result.eTag;

        return blob.putBlock(containerName, blobName, { blockId: blockId1 }, 'blockblob1');
      }).then(function (){
        return blob.putBlockList(containerName, blobName, {
          uncommitted: [blockId1],
          ifMatch: eTag
        });
      }).then(function (result) {
        assert(result.eTag);
        assert(result.lastModified);
        eTag = result.eTag;

        return blob.putBlock(containerName, blobName, { blockId: blockId2 }, 'blockblob2');
      }).then(function (result) {
        return blob.putBlockList(containerName, blobName, {
          uncommitted: [blockId2],
          committed: [blockId1],
          ifNoneMatch: eTag
        });
      }).catch(function (error) {
        assert(error.code === 'ConditionNotMet')
        assert(error.statusCode === 412);

        return blob.putBlockList(containerName, blobName, {
          uncommitted: [blockId2],
          committed: [blockId1],
          ifUnmodifiedSince: date15MinAgo
        });
      }).catch(function (error) {
        assert(error.code === 'ConditionNotMet')
        assert(error.statusCode === 412);

        return blob.putBlockList(containerName, blobName, {
          uncommitted: [blockId2],
          committed: [blockId1],
          ifModifiedSince: date15MinAgo
        });
      });
    });

    test('list blobs', function () {
      return blob.listBlobs(containerName).then(function (result) {
        assert(result.blobs.length > 0);
      });
    });

    test('list blobs with uncommitted blobs', function () {
      blobName = tempBlockBlobNamePrefix + '_uncommitted';
      var blockId = blob.getBlockId('fastazure', 1, 1);
      return blob.putBlob(containerName, blobName, { type: 'BlockBlob' }).then(function () {
        return blob.putBlock(containerName, blobName, { blockId: blockId }, 'content');
      }).then(function () {
        return blob.listBlobs(containerName, { include: { uncommittedBlobs: true }});
      }).then(function (result) {
        assert(result.blobs.length > 0);
        var uncommittedBlob = null;

        result.blobs.forEach(function (blob) {
          if (blob.name === blobName) {
            uncommittedBlob = blob;
          }
        });
        assert(uncommittedBlob, 'Expected to find the uncommitted blob');
      });
    });

    test('list blobs with metadata', function () {
      blobName = tempBlockBlobNamePrefix + '_list_blobs_with_metadata';
      options = {
        type: 'BlockBlob',
        metadata:{
          origin: 'taskcluster'
        }
      };
      return blob.putBlob(containerName, blobName, options, 'content').then(function () {
        return blob.listBlobs(containerName, {include: {metadata: true}})
      }).then(function (result) {
        assert(result.blobs.length > 0);
        var blobWithMetadata = null;

        result.blobs.forEach(function (blob) {
          if (blob.name === blobName) {
            blobWithMetadata = blob;
          }
        });
        assert(blobWithMetadata, 'Expected to find the blob with metadata');
        assert(blobWithMetadata.metadata.origin === 'taskcluster');
      });
    });

    test('list blob with prefix', function () {
      return blob.listBlobs(containerName, {prefix: tempBlockBlobNamePrefix}).then(function (result) {
        assert(result.blobs.length > 0);
      });
    });

    test('Shared-Access-Signature(resourceType=container, all permissions, create a blob', function() {
      var sas = blob.sas(containerName, null, {
        start:    date15MinAgo,
        expiry:   new Date(Date.now() + 30 * 60 * 1000),
        resourceType: 'container',
        permissions: {
          read: true,
          add: true,
          create: true,
          write: true,
          delete: true,
          list: true
        }
      });
      var blobWithSas = new azure.Blob({
        accountId: blob.options.accountId,
        sas: sas
      });

      return blobWithSas.putBlob(containerName, 'blob-test', {type: 'BlockBlob'}, 'Hello world');
    });

    test('Shared-Access-Signature(resourceType=blob, all permissions, create a blob', function() {
      var sas = blob.sas(containerName, 'blob-test2', {
        start:    date15MinAgo,
        expiry:   new Date(Date.now() + 30 * 60 * 1000),
        resourceType: 'blob',
        permissions: {
          read: true,
          add: true,
          create: false,
          write: false,
          delete: true
        }
      });
      var blobWithSas = new azure.Blob({
        accountId: blob.options.accountId,
        sas: sas
      });

      return blobWithSas.putBlob(containerName, 'blob-test2', {type: 'BlockBlob'}, 'Hello world').catch(function(error) {
        assert(error.statusCode === 403);
        assert(error.code === 'AuthorizationPermissionMismatch');
      });
    });
  });

  // Cleanup
  suiteTeardown(function(){
    // delete all containers
    return blob.listContainers({
      prefix: containerNamePrefix
    }).then(function(result){
      var deletePromises = result.containers.map(function(container){
        return blob.deleteContainer(container.name);
      });

      return Promise.all(deletePromises);
    });
  });
});