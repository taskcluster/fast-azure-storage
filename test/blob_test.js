suite.only("Azure Blob", function() {
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

  suite("Container", function() {
    test('create container with metadata', function() {
      var containerName = containerNamePrefix + '-with-metadata';
      var options = {
        metadata: {
          testKey: 'testValue'
        }
      };

      return blob.createContainer(containerName, options);
    });

    test('create container without metadata', function() {
      var containerName = containerNamePrefix + '-without-metadata';

      return blob.createContainer(containerName, {});
    });

    test('create container with container access and check if the access level is correctly set', function() {
      var containerName = containerNamePrefix + '-with-access';
      var options = {
        publicLevelAccess: 'container'
      };

      return blob.createContainer(containerName, options)
        .then(function(){
          /* If the publicAccessLevel is `container`, clients can call:
           getContainerProperties, getContainerMetadata, listBlobs anonymously
           */
          return anonymousBlob.getContainerProperties(containerName).then(function(result){
            assert(result.properties.eTag);
            assert(result.properties.lastModified);
            assert(result.properties.leaseStatus);
            assert(result.properties.leaseState);
            assert(result.properties.publicAccessLevel === 'container');
          });
        })
    });

    test('set and get container metadata', function() {
      var containerName = containerNamePrefix + '-set-get-metadata';

      // create a container without metadata
      return blob.createContainer(containerName, {})
        .then(function(){
          // set metadata to newly created container
          var metadata = {
            appName: 'fast-azure-storage'
          }
          return blob.setContainerMetadata(containerName, metadata);
        })
        .then(function(){
          return blob.getContainerMetadata(containerName);
        })
        .then(function(result){
          // verify if the metadata was correctly set
          assert(result.metadata.appName === 'fast-azure-storage');
        });
    });

    test('list containers with prefix', function() {
      return blob.listContainers({
        prefix: containerNamePrefix
      }).then(function(result){
        assert(result.containers.length > 0);
      });
    });

    test('list containers with prefix and metadata', function() {
      return blob.listContainers({
        prefix: containerNamePrefix,
        metadata: true
      }).then(function(result){
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
      return blob.listContainers({
        metadata: true
      }).then(function(result){
        assert(result.containers.length > 0);
      });
    });

    test('get container properties', function(){
      var containerName = containerNamePrefix + '-with-properties';
      var options = {
        metadata : {
          appName: 'fast-azure-storage'
        }
      };
      return blob.createContainer(containerName, options).then(function(){
        return blob.getContainerProperties(containerName).then(function(result){
          assert(result.metadata.appName === 'fast-azure-storage');
          assert(result.properties.eTag);
          assert(result.properties.lastModified);
          assert(result.properties.leaseStatus);
          assert(result.properties.leaseState);
        });
      });
    });

    test('get container (with access level, without metadata) properties', function(){
      var containerName = containerNamePrefix + '-with-access';
      return blob.getContainerProperties(containerName).then(function(result){
        assert(result.properties.eTag);
        assert(result.properties.lastModified);
        assert(result.properties.leaseStatus);
        assert(result.properties.leaseState);
        assert(result.properties.publicAccessLevel === 'container');
      });
    });

    test('set, get container ACL', function(){
      var containerName = containerNamePrefix + '-with-acl';

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
        var options = {
          publicAccessLevel: 'container',
          accessPolicies: accessPolicies
        }
        return blob.setContainerACL(containerName, options);
      }).then(function(){
        return blob.getContainerACL(containerName).then(function (result) {
          assert(result.publicAccessLevel === 'container');
          assert(result.accessPolicies.length === 2);

          assert(result.accessPolicies[0].id === '1');
          assert(result.accessPolicies[0].permission.read === true);
          assert(result.accessPolicies[0].permission.list === true);
          assert(result.accessPolicies[0].permission.delete === false);
          assert(result.accessPolicies[0].permission.add === true);
          assert(result.accessPolicies[0].permission.create === true);
          assert(result.accessPolicies[0].permission.write === true);

          assert(result.accessPolicies[1].id === '2');
          assert(result.accessPolicies[1].permission.read === false);
          assert(result.accessPolicies[1].permission.list === false);
          assert(result.accessPolicies[1].permission.delete === false);
          assert(result.accessPolicies[1].permission.add === false);
          assert(result.accessPolicies[1].permission.create === false);
          assert(result.accessPolicies[1].permission.write === false);
        });
      });
    });

    test('Shared-Access-Signature (with access policy which has list permission)', function(){
      var containerName = containerNamePrefix + '-with-acl';
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
      var containerName = containerNamePrefix + '-with-acl';
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
      var containerName = containerNamePrefix + '-with-metadata';
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

    test("Shared-Access-Signature (will refresh)", function() {
      var containerName = containerNamePrefix + '-with-metadata';
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
      var containerName = containerNamePrefix + '-with-metadata';
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
      var containerName = containerNamePrefix + '-with-metadata';
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

    // TODO add more tests for SAS when blob rest endpoints are implemented

    test('acquire a lease for a container, forbid delete container and release the lease', function(){
      var containerName = containerNamePrefix + '-with-lease';
      return blob.createContainer(containerName).then(function(){
        var leaseOptions = {
          leaseAction: 'acquire',
          leaseDuration: 15
        };
        return blob.leaseContainer(containerName,leaseOptions).then(function(result){
          assert(result.leaseId);
          return blob.deleteContainer(containerName).catch(function(err){
            assert(err.statusCode === 412);
            return blob.leaseContainer(containerName, {
              leaseAction: 'release',
              leaseId: result.leaseId
            });
          });
        });
      });
    });

    test('acquire a lease for a container with if-modified-since and if-unmodified-since conditional header', function () {
      var containerName = containerNamePrefix + '-conditional-header';
      return blob.createContainer(containerName)
        .then(function (result) {
          assert(result.eTag);
          assert(result.lastModified);

          var options = {
            leaseAction: 'acquire',
            leaseDuration: 15,
            ifUnmodifiedSince: date15MinAgo
          };

          return blob.leaseContainer(containerName, options);
        })
        .catch(function (error) {
          assert(error.code === 'ConditionNotMet');
          assert(error.statusCode === 412);

          return blob.leaseContainer(containerName, {
            leaseAction: 'acquire',
            leaseDuration: 15,
            ifModifiedSince: date15MinAgo
          })
        })
        .then(function (result) {
          assert(result.leaseId);
          assert(result.eTag);
          assert(result.lastModified);

          return blob.leaseContainer(containerName, {
            leaseAction: 'release',
            leaseId: result.leaseId
          });
        });
    });

    test('delete container with if-modified-since conditional header', function () {
      var containerName = containerNamePrefix + '-delete-with-condition';
      return blob.createContainer(containerName)
        .then(function (result) {
          assert(result.eTag);
          assert(result.lastModified);

          return blob.deleteContainer(containerName, {ifModifiedSince: new Date(Date.now())})
        })
        .catch(function (error) {
          assert(error.code === 'ConditionNotMet');
          assert(error.statusCode === 412);

          return blob.setContainerMetadata(containerName, {scope: 'test'});
        })
        .then(function (result) {
          assert(result.eTag);
          assert(result.lastModified);

          return blob.deleteContainer(containerName, {ifModifiedSince: date15MinAgo});
        });
    });

    test('delete container with if-unmodified-since conditional header', function () {
      var containerName = containerNamePrefix + '-delete-with-condition2';
      return blob.createContainer(containerName)
        .then(function (result) {
          assert(result.eTag);
          assert(result.lastModified);

          return blob.deleteContainer(containerName, {ifUnmodifiedSince: date15MinAgo})
        })
        .catch(function (error) {
          assert(error.code === 'ConditionNotMet');
          assert(error.statusCode === 412);

          return blob.deleteContainer(containerName, {ifUnmodifiedSince: new Date(Date.now())});
        });
    });

    test('set container metadata with if-modified-since conditional header', function () {
      var containerName = containerNamePrefix + '-set-metadata-conditional-header';
      return blob.createContainer(containerName)
        .then(function (result) {
          assert(result.eTag);
          assert(result.lastModified);

          return blob.setContainerMetadata(containerName, {scope: 'test'}, {ifModifiedSince: date15MinAgo});
        })
        .then(function (result) {
          return blob.setContainerMetadata(containerName, {scope: 'test2'}, {ifModifiedSince: new Date(Date.now())});
        })
        .catch(function (error) {
          assert(error.code === 'ConditionNotMet');
          assert(error.statusCode === 412);
        })
    });
  });
  suite("Blob", function() {
    var containerName = containerNamePrefix + '-with-blobs';
    var blockBlobName = 'blobTest';
    var appendBlobName = 'appendBlobTest';
    var tempBlockBlobNamePrefix = 'tempBlockBlob';

    suiteSetup(function() {
      return blob.createContainer(containerName);
    });

    test('put text block blob', function(){
      var options = {
        blobType: 'BlockBlob'
      };
      var content = 'hello world';
      return blob.putBlob(containerName, blockBlobName, options, content);
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
      return blob.setBlobMetadata(containerName, blockBlobName, metadata)
        .then(function() {
          return blob.getBlobMetadata(containerName, blockBlobName);
        })
        .then(function(result){
          assert(result.metadata.origin === 'taskcluster');
        });
    });

    test('set and get blob properties', function() {
      var options = {
        cacheControl: 'no-cache',
        contentType: 'text/plain;charset="utf8"',
        contentEncoding: 'gzip',
        contentLanguage: 'en-US',
        contentDisposition: 'attachment; filename="file.txt"'
      }

      return blob.setBlobProperties(containerName, blockBlobName, options)
        .then(function() {
          return blob.getBlobProperties(containerName, blockBlobName);
        })
        .then(function(result) {
          assert(result.blobType === 'BlockBlob');
          assert(result.contentLength === '11');
          assert(result.contentType === 'text/plain;charset="utf8"');
          assert(result.contentEncoding === 'gzip');
          assert(result.contentLanguage === 'en-US');
          assert(result.contentDisposition === 'attachment; filename="file.txt"');
          assert(result.metadata.origin === 'taskcluster');
        });
    });

    test('put block, getBlockList and putBlockList', function () {
      var blockContent1 = Buffer.from("Lorem Ipsum is simply dummy text of the printing and typesetting industry. " +
        "Lorem Ipsum has been the industry's standard dummy text ever since the 1500s, when an unknown printer took a" +
        " galley of type and scrambled it to make a type specimen book. It has survived not only five centuries, but also" +
        " the leap into electronic typesetting, remaining essentially unchanged. It was popularised in the 1960s with the " +
        "release of Letraset sheets containing Lorem Ipsum passages, and more recently with desktop publishing software like Aldus PageMaker including versions of Lorem Ipsum.");
      var blockId1 = blob.getBlockId('fastazure', 1, 3);

      var blockContent2 = 'Contrary to popular belief, Lorem Ipsum is not simply random text. It has roots in a piece of classical Latin literature from 45 BC, making it over 2000 years old.';
      var blockId2 = blob.getBlockId('fastazure', 2, 3);

      var options = {
        blockId: blockId1
      }
      // put a new block to a block blob
      return blob.putBlock(containerName, blockBlobName, options, blockContent1)
        .then(function () {
          var options = {
            blockListType: 'all'
          };
          return blob.getBlockList(containerName, blockBlobName, options);
        })
        // verify that the block list contains an uncommitted block
        .then(function (result) {
          assert(result.uncommittedBlocks.length === 1);
          assert(result.uncommittedBlocks[0].blockId === blockId1);
          assert(result.committedBlocks.length === 0);

          // commit the block uploaded
          var opt = {
            uncommittedBlockIds: [result.uncommittedBlocks[0].blockId]
          }
          return blob.putBlockList(containerName, blockBlobName, opt);
        })
        // verify the commit of the block
        .then(function () {
          return blob.getBlob(containerName, blockBlobName).then(function (result) {
            assert(result.content === blockContent1.toString());

            // commit another block
            return blob.putBlock(containerName, blockBlobName, {
              blockId: blockId2
            }, blockContent2);
          })
          // verify that the block list contains an uncommitted block and a committed block
            .then(function () {
              return blob.getBlockList(containerName, blockBlobName, {
                blockListType: 'all'
              });
            })
            .then(function(result) {
              assert(result.uncommittedBlocks.length === 1);
              assert(result.uncommittedBlocks[0].blockId === blockId2);
              assert(result.committedBlocks.length === 1);

              return blob.putBlockList(containerName, blockBlobName, {
                committedBlockIds: [result.committedBlocks[0].blockId],
                uncommittedBlockIds: [result.uncommittedBlocks[0].blockId]
              });
            })
            // verify that the blob is updated
            .then(function (result) {
              return blob.getBlob(containerName, blockBlobName);
            })
            .then(function (result) {
              assert(result.content === (blockContent1.toString() + blockContent2));
            })
        });
    });

    test('create append blob', function() {
      var options = {
        blobType: 'AppendBlob'
      };
      return blob.putBlob(containerName, appendBlobName, options);
    });

    test('append block blob', function () {
      var blobName = 'AppendBlob';
      var content = Buffer.from("Lorem Ipsum is simply dummy text of the printing and typesetting industry. " +
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
      var name = tempBlockBlobNamePrefix + '_if_match_conditional_header';
      return blob.putBlob(containerName, name, {blobType: 'BlockBlob'}, 'Hello world')
        .then(function (result) {
          assert(result.eTag);

          return blob.deleteBlob(containerName, name, {
            ifMatch: result.eTag
          });
        });
    });

    test('delete blob with if-non-match conditional header', function () {
      var name = tempBlockBlobNamePrefix + '_if_none_matching_conditional_header';
      return blob.putBlob(containerName, name, {blobType: 'BlockBlob'}, 'Hello world')
        .then(function (result) {
          assert(result.eTag);

          return blob.deleteBlob(containerName, name, {
            ifNoneMatch: result.eTag
          });
        })
        .catch(function (error){
          assert(error.code === 'ConditionNotMet');
          assert(error.statusCode === 412);
        })
    });

    test('delete blob with if-modified-since conditional header', function (){
      var name = tempBlockBlobNamePrefix + '_if_modified_since_conditional_header';

      return blob.putBlob(containerName, name, {blobType: 'BlockBlob'}, 'Hello world')
        .then(function (result) {
          return blob.setBlobMetadata(containerName, name, {scope: 'test'})
        })
        .then(function (result) {
          assert(result.lastModified);
          assert(result.eTag);
          return blob.deleteBlob(containerName, name, {
            ifModifiedSince: date15MinAgo
          });
        });
    });

    test('delete blob with if-unmodified-since conditional header', function () {
      var name = tempBlockBlobNamePrefix + '_if_unmodified_since_conditional_header';

      return blob.putBlob(containerName, name, {blobType: 'BlockBlob'}, 'Hello world')
        .then(function (result) {
          return blob.setBlobMetadata(containerName, name, {scope: 'test'})
        })
        .then(function (result) {
          assert(result.lastModified);
          assert(result.eTag);
          return blob.deleteBlob(containerName, name, {
            ifUnmodifiedSince: new Date(Date.now())
          });
        })
        .catch(function (error) {
          assert(error.code === 'ConditionNotMet');
          assert(error.statusCode === 412);
        });
    });

    test('get blob with if-match conditional header', function () {
      var name = tempBlockBlobNamePrefix + 'get_blob_if_match_conditional_header';

      return blob.putBlob(containerName, name, {blobType: 'BlockBlob'}, 'Hello world')
        .then(function (result) {
          assert(result.eTag);

          return blob.getBlob(containerName, name, {
            ifMatch: result.eTag
          });
        });
    });

    test('get blob with if-none-match conditional header', function () {
      var name = tempBlockBlobNamePrefix + 'get_blob_if_none_match_conditional_header';
      return blob.putBlob(containerName, name, {blobType: 'BlockBlob'}, 'Hello world')
        .then(function (result) {
          return blob.setBlobProperties(containerName, name, {contentType: 'text/plain; charset="utf8"'})
        })
        .then(function (result) {
          assert(result.eTag);
          assert(result.lastModified);

          return blob.getBlob(containerName, name, {
            ifNoneMatch: result.eTag
          });
        })
        .catch(function (error) {
          assert(error.code === 'ConditionNotMet');
          assert(error.statusCode === 412);
        });
    });

    test('get blob with if-modified-since conditional header', function () {
      var name = tempBlockBlobNamePrefix + 'get_blob_if_modified_since_conditional_header';
      var blockId = blob.getBlockId('fastazure', 1, 2);
      return blob.putBlob(containerName, name, {blobType: 'BlockBlob'})
        .then(function () {
          return blob.putBlock(containerName, name, {blockId: blockId}, 'hello world');
        })
        .then(function () {
          return blob.putBlockList(containerName, name, {uncommittedBlockIds:[blockId]})
        })
        .then(function (result) {
          assert(result.eTag);
          assert(result.lastModified);

          return blob.getBlob(containerName, name, {
            ifModifiedSince: date15MinAgo
          });
        });
    });

    test('get blob with if-unmodified-since conditional header', function () {
      var name = tempBlockBlobNamePrefix + 'get_blob_if_unmodified_since_conditional_header';
      return blob.putBlob(containerName, name, {blobType: 'BlockBlob'})
        .then(function () {
          return blob.setBlobMetadata(containerName, name, {scope: 'test'});
        })
        .then(function (result) {
          assert(result.lastModified);
          return blob.getBlob(containerName, name, {ifUnmodifiedSince: result.lastModified});
        })
    });

    test('get blob metadata with if-modified-since, if-unmodified-since, if-match and if-none-match conditional header', function () {
      var name = tempBlockBlobNamePrefix + '_with_metadata';
      return blob.putBlob(containerName, name, {blobType: 'AppendBlob'})
        .then(function () {
          return blob.setBlobMetadata(containerName, name, {appName: 'fast-azure'});
        })
        .then(function (result) {
          assert(result.eTag);
          return blob.getBlobMetadata(containerName, name, {ifMatch: result.eTag});
        })
        .then(function (result) {
          assert(result.metadata.appName === 'fast-azure');

          return blob.getBlobMetadata(containerName, name, {ifNoneMatch: result.eTag});
        })
        .catch(function (error) {
          // result code if condition has not been met it should be 'Not modified(304)'
          assert(error.statusCode === 304);

          return blob.getBlobMetadata(containerName, name, {
            ifModifiedSince: date15MinAgo
          });
        })
        .then(function (result) {
          assert(result.lastModified);

          return blob.getBlobMetadata(containerName, name, {
            ifUnmodifiedSince: date15MinAgo
          });
        })
        .catch(function (error) {
          assert(error.statusCode === 412);
        })
    });

    test('get blob properties with if-modified-since, if-unmodified-since, if-match and if-none-match conditional header', function () {
      var name = tempBlockBlobNamePrefix + '_with_properties';

      return blob.putBlob(containerName, name, {blobType: 'BlockBlob'})
        .then(function () {
          return blob.setBlobProperties(containerName, name, {contentLanguage: 'en-EN'});
        })
        .then(function (result) {
          assert(result.eTag);
          return blob.getBlobProperties(containerName, name, {ifMatch: result.eTag});
        })
        .then(function (result) {
          assert(result.contentLanguage === 'en-EN');

          return blob.getBlobProperties(containerName, name, {ifNoneMatch: result.eTag});
        })
        .catch(function (error) {
          assert(error.statusCode === 304);

          return blob.getBlobProperties(containerName, name, {
            ifModifiedSince: date15MinAgo
          });
        })
        .then(function (result) {
          assert(result.lastModified);
          return blob.getBlobProperties(containerName, name, {
            ifUnmodifiedSince: date15MinAgo
          });
        })
        .catch(function (error) {
          assert(error.statusCode === 412);
        })
    });

    test('set blob metadata with if-modified-since, if-unmodified-since, if-match and if-none-match conditional header', function () {
      var name = tempBlockBlobNamePrefix + '_with_metadata_conditional_headers';
      return blob.putBlob(containerName, name, {blobType: 'BlockBlob'})
        .then(function (result) {
          assert(result.lastModified);
          assert(result.eTag);
          return blob.setBlobMetadata(containerName, name, {application: 'azure'}, {ifMatch: result.eTag});
        })
        .then(function (result) {
          assert(result.eTag);
          assert(result.lastModified);

          return blob.setBlobMetadata(containerName, name, {scope: 'test'}, {ifNoneMatch: result.eTag});
        })
        .catch(function (error) {
          assert(error.code === 'ConditionNotMet');
          assert(error.statusCode === 412);

          return blob.setBlobMetadata(containerName, name, {scope: 'test'}, {
            ifModifiedSince: new Date(Date.now())
          });
        })
        .then(function (result) {
          assert(result.eTag);
          assert(result.lastModified);

          return blob.setBlobMetadata(containerName, name, {scope: 'test'}, {
            ifUnmodifiedSince: date15MinAgo
          });
        })
        .catch(function (error) {
          assert(error.code === 'ConditionNotMet');
          assert(error.statusCode === 412);
        })
    });

    test('set blob properties with if-modified-since, if-unmodified-since, if-match and if-none-match conditional header', function () {
      var name = tempBlockBlobNamePrefix + '_with_props_conditional_headers';
      return blob.putBlob(containerName, name, {blobType: 'BlockBlob'})
        .then(function (result) {
          assert(result.lastModified);
          assert(result.eTag);
          return blob.setBlobProperties(containerName, name, {contentEncoding: 'gzip'}, {ifMatch: result.eTag});
        })
        .then(function (result) {
          assert(result.eTag);
          assert(result.lastModified);

          return blob.setBlobProperties(containerName, name, {contentEncoding: 'gzip'}, {ifNoneMatch: result.eTag});
        })
        .catch(function (error) {
          assert(error.code === 'ConditionNotMet');
          assert(error.statusCode === 412);

          return blob.setBlobProperties(containerName, name, {contentEncoding: 'gzip'}, {
            ifModifiedSince: new Date(Date.now())
          });
        })
        .then(function (result) {
          assert(result.eTag);
          assert(result.lastModified);

          return blob.setBlobProperties(containerName, name, {contentEncoding: 'gzip'}, {
            ifUnmodifiedSince: date15MinAgo
          });
        })
        .catch(function (error) {
          assert(error.code === 'ConditionNotMet');
          assert(error.statusCode === 412);
        });
    });

    test('put blob with if-modified-since, if-unmodified-since, if-match and if-none-match conditional header', function () {
      var name = tempBlockBlobNamePrefix + '_put_blob_with_conditional_headers';
      return blob.putBlob(containerName, name, {blobType: 'BlockBlob'})
        .then(function (result) {
          assert(result.lastModified);
          assert(result.eTag);
          return blob.putBlob(containerName, name, {
            blobType: 'BlockBlob',
            ifMatch: result.eTag
          }, 'hello world');
        })
        .then(function (result) {
          assert(result.lastModified);
          assert(result.eTag);
          return blob.putBlob(containerName, name, {
            blobType: 'BlockBlob',
            ifNoneMatch: result.eTag
          }, 'hello again');
        })
        .catch(function (error) {
          assert(error.code === 'ConditionNotMet');
          assert(error.statusCode === 412);

          return blob.putBlob(containerName, name, {
            blobType: 'BlockBlob',
            ifModifiedSince: new Date(Date.now())
          }, 'hello from error');
        })
        .then(function (result) {
          assert(result.eTag);
          assert(result.lastModified);

          blob.putBlob(containerName, name, {
            blobType: 'BlockBlob',
            ifUnmodifiedSince: date15MinAgo
          }, 'hello from error');
        })
        .catch(function (error) {
          assert(error.code === 'ConditionNotMet');
          assert(error.statusCode === 412);
        });
    });

    test('append block with if-modified-since, if-unmodified-since, if-match and if-none-match conditional header', function () {
      var name = tempBlockBlobNamePrefix + '_append_block_with_conditional_headers';
      return blob.putBlob(containerName, name, {blobType: 'AppendBlob'})
        .then(function (result) {
          assert(result.lastModified);
          assert(result.eTag);
          return blob.appendBlock(containerName, name, {
            ifMatch: result.eTag
          }, 'log1');
        })
        .then(function (result) {
          assert(result.lastModified);
          assert(result.eTag);
          return blob.appendBlock(containerName, name, {
            ifNoneMatch: result.eTag
          }, 'log2');
        })
        .catch(function (error) {
          assert(error.code === 'ConditionNotMet');
          assert(error.statusCode === 412);

          return blob.appendBlock(containerName, name, {
            ifModifiedSince: new Date(Date.now())
          }, 'log3');
        })
        .then(function (result) {
          assert(result.eTag);
          assert(result.lastModified);

          blob.appendBlock(containerName, name, {
            ifUnmodifiedSince: date15MinAgo
          }, 'log4');
        })
        .catch(function (error) {
          assert(error.code === 'ConditionNotMet');
          assert(error.statusCode === 412);
        });
    });

    test('putBlockList with if-modified-since, if-unmodified-since, if-match and if-none-match conditional header', function () {
      var name = tempBlockBlobNamePrefix + '_put_block_list_with_conditional_headers';
      var blockId1 = blob.getBlockId('fastazure', 1, 1);
      var blockId2 = blob.getBlockId('fastazure', 2, 1);
      var eTag = null;
      return blob.putBlob(containerName, name, {blobType: 'BlockBlob'})
        .then(function (result) {
          assert(result.eTag);
          eTag = result.eTag;

          return blob.putBlock(containerName, name, {blockId: blockId1}, 'blockblob1');
        })
        .then(function (){
          return blob.putBlockList(containerName, name, {
            uncommitted: [blockId1],
            ifMatch: eTag
          });
        })
        .then(function (result) {
          assert(result.eTag);
          assert(result.lastModified);
          eTag = result.eTag;

          return blob.putBlock(containerName, name, {blockId: blockId2}, 'blockblob2');
        })
        .then(function (result) {
          return blob.putBlockList(containerName, name, {
            uncommitted: [blockId2],
            committed: [blockId1],
            ifNoneMatch: eTag
          });
        })
        .catch(function (error) {
          assert(error.code === 'ConditionNotMet')
          assert(error.statusCode === 412);

          return blob.putBlockList(containerName, name, {
            uncommitted: [blockId2],
            committed: [blockId1],
            ifUnmodifiedSince: date15MinAgo
          });
        })
        .catch(function (error) {
          assert(error.code === 'ConditionNotMet')
          assert(error.statusCode === 412);

          return blob.putBlockList(containerName, name, {
            uncommitted: [blockId2],
            committed: [blockId1],
            ifModifiedSince: date15MinAgo
          });
        });
    });

    test('list blobs', function () {
      return blob.listBlobs(containerName)
        .then(function (result) {
          assert(result.blobs.length > 0);
        });
    });

    test('list blobs with uncommitted blobs', function () {
      var name = tempBlockBlobNamePrefix + '_uncommitted';
      var blockId = blob.getBlockId('fastazure', 1, 1);
      return blob.putBlob(containerName, name, {blobType: 'BlockBlob'})
        .then(function () {
          return blob.putBlock(containerName, name, {blockId: blockId}, 'content');
        })
        .then(function () {
          return blob.listBlobs(containerName, {include: {uncommittedBlobs: true}});
        })
        .then(function (result) {
          assert(result.blobs.length > 0);
          var uncommittedBlob = null;

          result.blobs.forEach(function (blob) {
            if (blob.name === name) {
              uncommittedBlob = blob;
            }
          });
          assert(uncommittedBlob, 'Expected to find the uncommitted blob');
        });
    });

    test('list blobs with metadata', function () {
      var name = tempBlockBlobNamePrefix + '_list_blobs_with_metadata';
      return blob.putBlob(containerName, name, {
        blobType: 'BlockBlob',
        metadata:{
          origin: 'taskcluster'
        }
      }, 'content')
        .then(function () {
          return blob.listBlobs(containerName, {include: {metadata: true}})
        })
        .then(function (result) {
          assert(result.blobs.length > 0);
          var blobWithMetadata = null;

          result.blobs.forEach(function (blob) {
            if (blob.name === name) {
              blobWithMetadata = blob;
            }
          });
          assert(blobWithMetadata, 'Expected to find the blob with metadata');
          assert(blobWithMetadata.metadata.origin === 'taskcluster');
        });
    });

    test('list blob with prefix', function () {
      return blob.listBlobs(containerName, {prefix: tempBlockBlobNamePrefix})
        .then(function (result) {
          assert(result.blobs.length > 0);
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