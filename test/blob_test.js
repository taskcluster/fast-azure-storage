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

  suite("Container", function() {
    test('create container with metadata', function() {
      var containerName = containerNamePrefix + '-with-metadata';
      var metadata = {
        testKey: 'testValue'
      };

      return blob.createContainer(containerName, metadata, null);
    });

    test('create container without metadata', function() {
      var containerName = containerNamePrefix + '-without-metadata';

      return blob.createContainer(containerName, {}, null);
    });

    test('create container with container access and check if the access level is correctly set', function() {
      var containerName = containerNamePrefix + '-with-access';

      return blob.createContainer(containerName, {}, 'container')
        .then(function(){
        /* If the publicAccessLevel is `container`, clients can call:
          getContainerProperties, getContainerMetadata, listBlobs anonymously
         */
        return anonymousBlob.getContainerProperties(containerName).then(function(response){
          assert(response.properties.eTag);
          assert(response.properties.lastModified);
          assert(response.properties.leaseStatus);
          assert(response.properties.leaseState);
          assert(response.properties.publicAccessLevel === 'container');
        });
      })
    });

    test('set and get container metadata', function() {
      var containerName = containerNamePrefix + '-set-get-metadata';

      // create a container without metadata
      return blob.createContainer(containerName, {}, null)
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
          assert(result.appName === 'fast-azure-storage');
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
      var metadata = {
        appName: 'fast-azure-storage'
      }
      return blob.createContainer(containerName, metadata, null).then(function(){
        return blob.getContainerProperties(containerName).then(function(response){
          assert(response.metadata.appName === 'fast-azure-storage');
          assert(response.properties.eTag);
          assert(response.properties.lastModified);
          assert(response.properties.leaseStatus);
          assert(response.properties.leaseState);
        });
      });
    });

    test('get container (with access level, without metadata) properties', function(){
      var containerName = containerNamePrefix + '-with-access';
      return blob.getContainerProperties(containerName).then(function(response){
        assert(response.properties.eTag);
        assert(response.properties.lastModified);
        assert(response.properties.leaseStatus);
        assert(response.properties.leaseState);
        assert(response.properties.publicAccessLevel === 'container');
      });
    });

    test('set, get container ACL', function(){
      var containerName = containerNamePrefix + '-with-acl';

      return blob.createContainer(containerName, {}, null).then(function(){
        var accessPolicies = [
          {
            id: 1,
            start: new Date(Date.now() - 15 * 60 * 1000),
            permission: {
              read: true,
              write: true,
              list: true,
            }
          },
          {
            id: 2,
            start: new Date(Date.now() - 15 * 60 * 1000),
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
        return blob.getContainerACL(containerName).then(function (response) {
          assert(response.publicAccessLevel === 'container');
          assert(response.accessPolicies.length === 2);

          assert(response.accessPolicies[0].id === '1');
          assert(response.accessPolicies[0].permission.read === true);
          assert(response.accessPolicies[0].permission.list === true);
          assert(response.accessPolicies[0].permission.delete === false);
          assert(response.accessPolicies[0].permission.add === false);
          assert(response.accessPolicies[0].permission.create === false);
          assert(response.accessPolicies[0].permission.write === true);

          assert(response.accessPolicies[1].id === '2');
          assert(response.accessPolicies[1].permission.read === false);
          assert(response.accessPolicies[1].permission.list === false);
          assert(response.accessPolicies[1].permission.delete === false);
          assert(response.accessPolicies[1].permission.add === false);
          assert(response.accessPolicies[1].permission.create === false);
          assert(response.accessPolicies[1].permission.write === false);
        });
      });
    });

    test('Shared-Access-Signature (with access policy which has list permission)', function(){
      var containerName = containerNamePrefix + '-with-acl';
      var sas = blob.sas(containerName, null, {
        expiry:   new Date(Date.now() + 30 * 60 * 1000),
        resourceType: 'c',
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
        resourceType: 'c',
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
        start:    new Date(Date.now() - 15 * 60 * 1000),
        expiry:   new Date(Date.now() + 30 * 60 * 1000),
        resourceType: 'c',
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
          resourceType: 'c',
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
          resourceType: 'c',
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

    // TODO modify the test when the blobs can be created
    test('list blobs within a container', function(){
      var containerName = containerNamePrefix + '-with-blobs';

      return blob.createContainer(containerName).then(function(){
        return blob.listBlobs(containerName).then(function(response){
          assert(response.blobs.length === 0);
        });
      })
    });

    test('acquire a lease for a container, forbid delete container and release the lease', function(){
      var containerName = containerNamePrefix + '-with-lease';
      return blob.createContainer(containerName).then(function(){
        var leaseOptions = {
          leaseAction: 'acquire',
          leaseDuration: 15
        };
        return blob.leaseContainer(containerName,leaseOptions).then(function(response){
          assert(response.leaseId);
          return blob.deleteContainer(containerName).catch(function(err){
            assert(err.statusCode === 412);
            return blob.leaseContainer(containerName, {
              leaseAction: 'release',
              leaseId: response.leaseId
            });
          });
        });
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