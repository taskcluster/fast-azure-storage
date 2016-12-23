suite.only("Azure Blob", function() {
  var azure   = require('../');
  var assert  = require('assert');

  // Create azure blob client
  var blob = new azure.Blob({
    accountId: process.env.AZURE_STORAGE_ACCOUNT,
    accessKey: process.env.AZURE_STORAGE_ACCESS_KEY
  });

  suite("Container", function() {
    test('create container with metadata', function() {
      var containerName = 'fast-azure-blob-container-with-metadata';
      var metadata = {
        testKey: 'testValue'
      };

      return blob.createContainer(containerName, metadata, null)
        .then(function(){
          return blob.deleteContainer(containerName);
        });
    });

    test('create container without metadata', function() {
      var containerName = 'fast-azure-blob-container';

      return blob.createContainer(containerName, {}, null)
        .then(function(){
          return blob.deleteContainer(containerName);
        });
    });

    test('create container with container access', function() {
      var containerName = 'fast-azure-blob-container-with-access';

      // TODO verify the listing!!
      return blob.createContainer(containerName, {}, null)
        .then(function(){
          return blob.deleteContainer(containerName);
        });
    });

    test('set and get container metadata', function() {
      var containerName = 'fast-azure-blob-container-set-get-metadata';

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

          // delete the container
          return blob.deleteContainer(containerName);
        });
    });
  });
});