suite("Table", function() {
  var assert  = require('assert');
  var Promise = require('promise');
  var azure   = require('../');
  var utils   = require('../lib/utils');
  var config  = require('typed-env-config');

  var cfg = config({});

  // Create azure table client
  var table = new azure.Table(cfg);

  // Table name for testing
  var tableName     = 'fastAzureStorageTestTable';
  var tempTableName = "fastAzureStorageTmpTestTable";

  test("createTable", function() {
    return table.createTable(tableName).catch(function(err) {
      // Ignore TableAlreadyExists errors
      if (err.code !== 'TableAlreadyExists') {
        throw err;
      }
    });
  });

  test("createTable, deleteTable", function() {
    return table.createTable(tempTableName).then(function() {
      return table.deleteTable(tempTableName);
    }).catch(function(err) {
      // Ignore TableBeingDeleted errors
      if (err.code !== 'TableBeingDeleted') {
        throw err;
      }
    });
  });

  test("queryTables", function() {
    return table.queryTables().then(function(result) {
      assert(result.tables.length > 0);
    });
  });

  test("insertEntity", function() {
    return table.insertEntity(tableName, {
      PartitionKey:       'test-pk-' + Math.random(),
      RowKey:             'test-rk',
      bool:               true,
      'date@odata.type':  'Edm.DateTime',
      'date':             new Date().toJSON(),
    });
  });

  // Special characters for testing, found using exhaustive key typing and
  // copy/paste from various websites. Does not include characters not allowed
  // in partition- and rowkey values.
  var SPECIAL_CHARACTERS = "&[]$£!^%@=~+_- 'øæå,\"" +
    ",¥¼ÑñΎΔδϠЉЩщӃԀԆԈԎԱԲաբסֶאבױ؟بحٍ۳܀ܐܠܘ݉ހސޤހި߄ߐ ߰ߋ߹ࢧ  ࣦ ࣲ ࣾতঃঅ৩৵ਠਂਅਉਠੱઠ," +
    "ઃઅઠૌ૩பஂஅபூ௩ഠഃഅഠൃ൩ෆංඑඣෆූกญกั๓აზჵ჻ᎠᎫᏎᏴᐁᑦᕵᙧᚠᚳᛦᛰᴂᴥᴽᵫ₢₣₪€⅛,⌂⌆" +
    "⌣⌽␂␊␢␣③⑷⒌ⓦ┍┝╤╳✃✈❄➓☂☺♀♪⟰⟶⟺⟿⨇⨋⫚⫸ⶀⶆⶐⷖ㌃㍻㎡㏵䷂䷫䷴䷾一憨田龥Ⅳⅸↂ,℀℃№™" +
    "∀∰⊇⋩";

  test("insertEntity, getEntity (special characters)", function() {
    var pk = 'test-pk-' + Math.random();
    var rk = 'rk-' + SPECIAL_CHARACTERS;
    return table.insertEntity(tableName, {
      PartitionKey:       pk,
      RowKey:             rk,
      value:              'some-value',
      'date@odata.type':  'Edm.DateTime',
      'date':             new Date().toJSON(),
      'bool@odata.type':  'Edm.Boolean',
      'bool':             true
    }).then(function() {
      return table.getEntity(tableName, pk, rk);
    }).then(function(entity) {
      assert(entity.value === 'some-value');
      assert(entity.date);
    });
  });

  test("getEntity ($select)", function() {
    var pk = 'test-pk-' + Math.random();
    var rk = 'rk';
    return table.insertEntity(tableName, {
      PartitionKey:       pk,
      RowKey:             rk,
      value:              'some-value',
      'date@odata.type':  'Edm.DateTime',
      'date':             new Date().toJSON()
    }).then(function() {
      return table.getEntity(tableName, pk, rk, {
        select:   ['value']
      });
    }).then(function(entity) {
      assert(entity.value === 'some-value');
      assert(!entity.date);
    });
  });

  test("getEntity ($filter, matched)", function() {
    var pk = 'test-pk-' + Math.random();
    var rk = 'rk';
    return table.insertEntity(tableName, {
      PartitionKey:       pk,
      RowKey:             rk,
      value:              SPECIAL_CHARACTERS,
      'value@odata.type': 'Edm.String',
      'date@odata.type':  'Edm.DateTime',
      'date':             new Date().toJSON()
    }).then(function() {
      var op = azure.Table.Operators;
      return table.getEntity(tableName, pk, rk, {
        filter: azure.Table.filter([
          'value', op.Equal, op.string(SPECIAL_CHARACTERS)
        ])
      });
    }).then(function(entity) {
      assert(entity.value === SPECIAL_CHARACTERS);
    });
  });

  test("getEntity ($filter, unmatched)", function() {
    var pk = 'test-pk-' + Math.random();
    var rk = 'rk';
    return table.insertEntity(tableName, {
      PartitionKey:       pk,
      RowKey:             rk,
      value:              'some-value',
      'date@odata.type':  'Edm.DateTime',
      'date':             new Date().toJSON()
    }).then(function() {
      var op = azure.Table.Operators;
      return table.getEntity(tableName, pk, rk, {
        filter: azure.Table.filter([
          'value', op.Equal, op.string('false-value')
        ])
      });
    }).then(function() {
      assert(false, "Expected error");
    }, function(err) {
      assert(err.code === 'ResourceNotFound');
    });
  });

  test("queryEntities w. $filter, $top, paging", function() {
    var pk = 'test-pk-' + Math.random();
    return Promise.all([
      table.insertEntity(tableName, {
        PartitionKey:       pk,
        RowKey:             'rk1',
        value:              'value1',
      }),
      table.insertEntity(tableName, {
        PartitionKey:       pk,
        RowKey:             'rk2',
        value:              'value2',
      })
    ]).then(function() {
      // Try with partition key
      var op = azure.Table.Operators;
      return table.queryEntities(tableName, {
        filter: azure.Table.filter([
          'PartitionKey', op.Equal, op.string(pk)
        ])
      }).then(function(result) {
        assert(result.entities.length === 2);
      });
    }).then(function() {
      // Try with wrong partition key
      var op = azure.Table.Operators;
      return table.queryEntities(tableName, {
        filter: azure.Table.filter([
          'PartitionKey', op.Equal, op.string(pk + '-wrong-pk')
        ])
      }).then(function(result) {
        assert(result.entities.length === 0);
      });
    }).then(function() {
      // Try with $top = 1
      var op = azure.Table.Operators;
      return table.queryEntities(tableName, {
        filter: azure.Table.filter([
          'PartitionKey', op.Equal, op.string(pk)
        ]),
        top:  1
      }).then(function(result) {
        assert(result.entities.length === 1);
        assert(result.entities[0].value === 'value1');
        assert(result.nextPartitionKey);
        assert(result.nextRowKey);
        // Test paging
        return table.queryEntities(tableName, {
          filter: azure.Table.filter([
            'PartitionKey', op.Equal, op.string(pk)
          ]),
          top:                1,
          nextPartitionKey:   result.nextPartitionKey,
          nextRowKey:         result.nextRowKey
        }).then(function(result) {
          assert(result.entities.length === 1);
          assert(result.entities[0].value === 'value2');
          assert(!result.nextPartitionKey);
          assert(!result.nextRowKey);
        });
      });
    });
  });

  test("queryEntities w. $filter, $select", function() {
    var pk = 'test-pk-' + Math.random();
    return Promise.all([
      table.insertEntity(tableName, {
        PartitionKey:       pk,
        RowKey:             'rk1',
        value:              'value1',
        extra:              'blabla'
      }),
      table.insertEntity(tableName, {
        PartitionKey:       pk,
        RowKey:             'rk2',
        value:              'value2',
        extra:              'blabla'
      })
    ]).then(function() {
      // Try with partition key
      var op = azure.Table.Operators;
      return table.queryEntities(tableName, {
        filter: azure.Table.filter([
          'PartitionKey', op.Equal, op.string(pk)
        ]),
        select: ['value', 'RowKey']
      });
    }).then(function(result) {
      assert(result.entities.length === 2);
      assert(result.entities[0].value);
      assert(result.entities[1].value);
      assert(result.entities[0].RowKey);
      assert(result.entities[1].RowKey);
      assert(!result.entities[0].extra);
      assert(!result.entities[1].extra);
    });
  });


  test("updateEntity (Insert or Replace) - insert", function() {
    var pk = 'test-pk-' + Math.random();
    var rk = 'rk';
    return table.updateEntity(tableName, {
      PartitionKey: pk,
      RowKey:       rk,
      value:        'my-string'
    }, {
      mode:         'replace',
      eTag:         null
    }).then(function(eTagAfterInsert) {
      return table.getEntity(tableName, pk, rk).then(function(entity) {
        assert(entity.value === 'my-string');
        assert(entity['odata.etag'] === eTagAfterInsert);
      });
    });
  });

  test("updateEntity (Insert or Replace) - replace", function() {
    var pk = 'test-pk-' + Math.random();
    var rk = 'rk';
    return table.insertEntity(tableName, {
      PartitionKey: pk,
      RowKey:       rk,
      value:        'old-string'
    }).then(function() {
      return table.updateEntity(tableName, {
        PartitionKey: pk,
        RowKey:       rk,
        value:        'new-string'
      }, {
        mode:         'replace',
        eTag:         null
      }).then(function(eTagAfterReplace) {
        return table.getEntity(tableName, pk, rk).then(function(entity) {
          assert(entity.value === 'new-string');
          assert(entity['odata.etag'] === eTagAfterReplace);
        });
      });
    });
  });

  test("updateEntity (Replace if exists) - exists", function() {
    var pk = 'test-pk-' + Math.random();
    var rk = 'rk';
    return table.insertEntity(tableName, {
      PartitionKey: pk,
      RowKey:       rk,
      value:        'old-string'
    }).then(function() {
      return table.updateEntity(tableName, {
        PartitionKey: pk,
        RowKey:       rk,
        value:        'new-string'
      }, {
        mode:         'replace',
        eTag:         '*'
      }).then(function(eTagAfterReplace) {
        return table.getEntity(tableName, pk, rk).then(function(entity) {
          assert(entity.value === 'new-string');
          assert(entity['odata.etag'] === eTagAfterReplace);
        });
      });
    });
  });

  test("updateEntity (Replace if exists) - missing", function() {
    var pk = 'test-pk-' + Math.random();
    var rk = 'rk';
    return table.updateEntity(tableName, {
      PartitionKey: pk,
      RowKey:       rk,
      value:        'new-string'
    }, {
      mode:         'replace',
      eTag:         '*'
    }).then(function() {
      assert(false, "Expected error");
    }, function(err) {
      assert(err.code === 'ResourceNotFound');
    });
  });

  test("updateEntity (Replace if ETag matches) - valid ETag", function() {
    var pk = 'test-pk-' + Math.random();
    var rk = 'rk';
    return table.insertEntity(tableName, {
      PartitionKey: pk,
      RowKey:       rk,
      value:        'old-string'
    }).then(function(eTagAfterInsert) {
      return table.updateEntity(tableName, {
        PartitionKey: pk,
        RowKey:       rk,
        value:        'new-string'
      }, {
        mode:         'replace',
        eTag:         eTagAfterInsert
      }).then(function(eTagAfterReplace) {
        return table.getEntity(tableName, pk, rk).then(function(entity) {
          assert(entity.value === 'new-string');
          assert(entity['odata.etag'] === eTagAfterReplace);
        });
      });
    });
  });

  test("updateEntity (Replace if ETag matches) - invalid ETag", function() {
    var pk = 'test-pk-' + Math.random();
    var rk = 'rk';
    return table.insertEntity(tableName, {
      PartitionKey: pk,
      RowKey:       rk,
      value:        'old-string'
    }).then(function() {
      return table.updateEntity(tableName, {
        PartitionKey: pk,
        RowKey:       rk,
        value:        'new-string'
      }, {
        mode:         'replace',
        // This eTag is probably wrong, usually is when hard coded
        eTag:         "W/\"datetime'2015-04-15T18%3A09%3A33.7853509Z'\""
      }).then(function() {
        assert(false, "Expected error");
      }, function(err) {
        assert(err.code === 'UpdateConditionNotSatisfied');
      });
    });
  });


  test("updateEntity (Insert or Merge) - insert", function() {
    var pk = 'test-pk-' + Math.random();
    var rk = 'rk';
    return table.updateEntity(tableName, {
      PartitionKey: pk,
      RowKey:       rk,
      value:        'my-string'
    }, {
      mode:         'merge',
      eTag:         null
    }).then(function(eTagAfterInsert) {
      return table.getEntity(tableName, pk, rk).then(function(entity) {
        assert(entity.value === 'my-string');
        assert(entity['odata.etag'] === eTagAfterInsert);
      });
    });
  });

  test("updateEntity (Insert or Merge) - merge", function() {
    var pk = 'test-pk-' + Math.random();
    var rk = 'rk';
    return table.insertEntity(tableName, {
      PartitionKey: pk,
      RowKey:       rk,
      newvalue:     'old-string',
      oldvalue:     'old-string'
    }).then(function() {
      return table.updateEntity(tableName, {
        PartitionKey: pk,
        RowKey:       rk,
        newvalue:     'new-string'
      }, {
        mode:         'merge',
        eTag:         null
      }).then(function(eTagAfterMerge) {
        return table.getEntity(tableName, pk, rk).then(function(entity) {
          assert(entity.newvalue === 'new-string');
          assert(entity.oldvalue === 'old-string');
          assert(entity['odata.etag'] === eTagAfterMerge);
        });
      });
    });
  });

  test("updateEntity (Merge if exists) - exists", function() {
    var pk = 'test-pk-' + Math.random();
    var rk = 'rk';
    return table.insertEntity(tableName, {
      PartitionKey: pk,
      RowKey:       rk,
      newvalue:     'old-string',
      oldvalue:     'old-string'
    }).then(function() {
      return table.updateEntity(tableName, {
        PartitionKey: pk,
        RowKey:       rk,
        newvalue:     'new-string'
      }, {
        mode:         'merge',
        eTag:         '*'
      }).then(function(eTagAfterMerge) {
        return table.getEntity(tableName, pk, rk).then(function(entity) {
          assert(entity.newvalue === 'new-string');
          assert(entity.oldvalue === 'old-string');
          assert(entity['odata.etag'] === eTagAfterMerge);
        });
      });
    });
  });

  test("updateEntity (Merge if exists) - missing", function() {
    var pk = 'test-pk-' + Math.random();
    var rk = 'rk';
    return table.updateEntity(tableName, {
      PartitionKey: pk,
      RowKey:       rk,
      newvalue:     'new-string'
    }, {
      mode:         'merge',
      eTag:         '*'
    }).then(function() {
      assert(false, "Expected error");
    }, function(err) {
      assert(err.code === 'ResourceNotFound');
    });
  });

  test("updateEntity (Merge if ETag matches) - valid ETag", function() {
    var pk = 'test-pk-' + Math.random();
    var rk = 'rk';
    return table.insertEntity(tableName, {
      PartitionKey: pk,
      RowKey:       rk,
      newvalue:     'old-string',
      oldvalue:     'old-string'
    }).then(function(eTagAfterInsert) {
      return table.updateEntity(tableName, {
        PartitionKey: pk,
        RowKey:       rk,
        newvalue:     'new-string'
      }, {
        mode:         'merge',
        eTag:         eTagAfterInsert
      }).then(function(eTagAfterMerge) {
        return table.getEntity(tableName, pk, rk).then(function(entity) {
          assert(entity.newvalue === 'new-string');
          assert(entity.oldvalue === 'old-string');
          assert(entity['odata.etag'] === eTagAfterMerge);
        });
      });
    });
  });

  test("updateEntity (Merge if ETag matches) - invalid ETag", function() {
    var pk = 'test-pk-' + Math.random();
    var rk = 'rk';
    return table.insertEntity(tableName, {
      PartitionKey: pk,
      RowKey:       rk,
      newvalue:     'old-string',
      oldvalue:     'old-string'
    }).then(function() {
      return table.updateEntity(tableName, {
        PartitionKey: pk,
        RowKey:       rk,
        newvalue:     'new-string'
      }, {
        mode:         'merge',
        // This eTag is probably wrong, usually is when hard coded
        eTag:         "W/\"datetime'2015-04-15T18%3A09%3A33.7853509Z'\""
      }).then(function() {
        assert(false, "Expected error");
      }, function(err) {
        assert(err.code === 'UpdateConditionNotSatisfied');
      });
    });
  });

  test("deleteEntity (If exists)", function() {
    var pk = 'test-pk-' + Math.random();
    var rk = 'rk';
    return table.insertEntity(tableName, {
      PartitionKey:       pk,
      RowKey:             rk,
      value:              'some-value',
    }).then(function() {
      return table.getEntity(tableName, pk, rk).then(function(entity) {
        assert(entity.value === 'some-value');
      });
    }).then(function() {
      return table.deleteEntity(tableName, pk, rk, {
        eTag:   '*'
      }).then(function() {
        return table.getEntity(tableName, pk, rk).then(function() {
          assert(false, "Expected error");
        }, function(err) {
          assert(err.code === 'ResourceNotFound');
        });
      });
    });
  });

  test("deleteEntity (valid ETag)", function() {
    var pk = 'test-pk-' + Math.random();
    var rk = 'rk';
    return table.insertEntity(tableName, {
      PartitionKey:       pk,
      RowKey:             rk,
      value:              'some-value',
    }).then(function(eTag) {
      return table.deleteEntity(tableName, pk, rk, {
        eTag:     eTag
      }).then(function() {
        return table.getEntity(tableName, pk, rk).then(function() {
          assert(false, "Expected error");
        }, function(err) {
          assert(err.code === 'ResourceNotFound');
        });
      });
    });
  });

  test("deleteEntity (invalid ETag)", function() {
    var pk = 'test-pk-' + Math.random();
    var rk = 'rk';
    return table.insertEntity(tableName, {
      PartitionKey:       pk,
      RowKey:             rk,
      value:              'some-value',
    }).then(function(eTag) {
      return table.deleteEntity(tableName, pk, rk, {
        // This eTag is probably wrong, usually is when hard coded
        eTag:       "W/\"datetime'2015-04-15T18%3A09%3A33.7853509Z'\""
      }).then(function() {
        assert(false, "Expected error");
      }, function(err) {
        assert(err.code === 'UpdateConditionNotSatisfied');
      });
    });
  });


  test("Shared-Access-Signature (fixed string, w. start)", function() {
    var sas = table.sas(tableName, {
      start:    new Date(Date.now() - 15 * 60 * 1000),
      expiry:   new Date(Date.now() + 30 * 60 * 1000),
      permissions: {
        read:   true,
        add:    true,
        update: true,
        delete: true
      }
    });
    var table2 = new azure.Table({
      accountId:    table.options.accountId,
      sas:          sas
    });
    var pk = 'test-pk-' + Math.random();
    var rk = 'rk';
    return table2.insertEntity(tableName, {
      PartitionKey:       pk,
      RowKey:             rk,
      value:              'some-value',
    });
  });

  test("Shared-Access-Signature (forbid add)", function() {
    var sas = table.sas(tableName, {
      start:    new Date(Date.now() - 15 * 60 * 1000),
      expiry:   new Date(Date.now() + 30 * 60 * 1000),
      permissions: {
        read:   true,
        add:    false,
        update: true,
        delete: true
      }
    });
    var table2 = new azure.Table({
      accountId:    table.options.accountId,
      sas:          sas
    });
    var pk = 'test-pk-' + Math.random();
    var rk = 'rk';
    return table2.insertEntity(tableName, {
      PartitionKey:       pk,
      RowKey:             rk,
      value:              'some-value',
    }).catch(function(err) {
      // Apparently it's not a 403, don't know why they return ResourceNotFound
      assert(400 <= err.statusCode && err.statusCode < 500);
    });
  });

  test("Shared-Access-Signature (will refresh)", function() {
    var refreshCount = 0;
    var refreshSAS = function() {
      refreshCount += 1;
      return table.sas(tableName, {
        expiry:   new Date(Date.now() + 15 * 60 * 1000 + 100),
        permissions: {
          read:   true,
          add:    true,
          update: true,
          delete: true
        }
      });
    };
    var table2 = new azure.Table({
      accountId:        table.options.accountId,
      sas:              refreshSAS,
      minSASAuthExpiry: 15 * 60 * 1000
    });
    var pk = 'test-pk-' + Math.random();
    return table2.insertEntity(tableName, {
      PartitionKey:       pk,
      RowKey:             'rk1',
      value:              'some-value',
    }).then(function() {
      assert(refreshCount === 1);
      return utils.sleep(200);
    }).then(function() {
      return table2.insertEntity(tableName, {
        PartitionKey:       pk,
        RowKey:             'rk2',
        value:              'some-value',
      });
    }).then(function() {
      assert(refreshCount === 2);
    });
  });

  test("Shared-Access-Signature (won't refresh on every call)", function() {
    var refreshCount = 0;
    var refreshSAS = function() {
      refreshCount += 1;
      return table.sas(tableName, {
        expiry:   new Date(Date.now() + 20 * 60 * 1000),
        permissions: {
          read:   true,
          add:    true,
          update: true,
          delete: true
        }
      });
    };
    var table2 = new azure.Table({
      accountId:        table.options.accountId,
      sas:              refreshSAS,
      minSASAuthExpiry: 15 * 60 * 1000
    });
    var pk = 'test-pk-' + Math.random();
    return table2.insertEntity(tableName, {
      PartitionKey:       pk,
      RowKey:             'rk1',
      value:              'some-value',
    }).then(function() {
      assert(refreshCount === 1);
      return utils.sleep(200);
    }).then(function() {
      return table2.insertEntity(tableName, {
        PartitionKey:       pk,
        RowKey:             'rk2',
        value:              'some-value',
      });
    }).then(function() {
      assert(refreshCount === 1);
    });
  });

  test("Shared-Access-Signature (async refresh)", function() {
    var refreshCount = 0;
    var refreshSAS = function() {
      refreshCount += 1;
      return utils.sleep(100).then(function() {
        return table.sas(tableName, {
          expiry:   new Date(Date.now() + 15 * 60 * 1000 + 100),
          permissions: {
            read:   true,
            add:    true,
            update: true,
            delete: true
          }
        });
      });
    };
    var table2 = new azure.Table({
      accountId:        table.options.accountId,
      sas:              refreshSAS,
      minSASAuthExpiry: 15 * 60 * 1000
    });
    var pk = 'test-pk-' + Math.random();
    return table2.insertEntity(tableName, {
      PartitionKey:       pk,
      RowKey:             'rk1',
      value:              'some-value',
    }).then(function() {
      assert(refreshCount === 1);
      return utils.sleep(200);
    }).then(function() {
      return Promise.all([
        table2.insertEntity(tableName, {
          PartitionKey:       pk,
          RowKey:             'rk2',
          value:              'some-value',
        }),
        table2.insertEntity(tableName, {
          PartitionKey:       pk,
          RowKey:             'rk3',
          value:              'some-value',
        })
      ]);
    }).then(function() {
      // Refreshes should only happen once, not twice in parallel
      assert(refreshCount === 2);
    });
  });

  test("Retries up to 5 times", function() {
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
    var pk = 'test-pk-' + Math.random();
    return table.insertEntity(tableName, {
      PartitionKey:       pk,
      RowKey:             'rk1',
      value:              'some-value',
    }).then(function() {
      utils.request = request;
      assert(false, "Expected an error");
    }, function(err) {
      utils.request = request;
      assert(err.code === 'ECONNRESET');
      assert(requestCount === 6, "Expected 1 request + 5 retries");
    });
  });

  test("azure.Table.Operators.string (plain)", function() {
    var val = azure.Table.Operators.string("test");
    var expected = "'test'";
    assert(val === expected, "Expected '" + expected + "' got '" + val + "'");
  });

  test("azure.Table.Operators.string (quote)", function() {
    var val = azure.Table.Operators.string("that's");
    var expected = "'that''s'";
    assert(val === expected, "Expected '" + expected + "' got '" + val + "'");
  });

  test("azure.Table.Operators.number (int)", function() {
    var val = azure.Table.Operators.number(42);
    var expected = "42";
    assert(val === expected, "Expected '" + expected + "' got '" + val + "'");
  });

  test("azure.Table.Operators.number (-int)", function() {
    var val = azure.Table.Operators.number(-42);
    var expected = "-42";
    assert(val === expected, "Expected '" + expected + "' got '" + val + "'");
  });

  test("azure.Table.Operators.number (float)", function() {
    var val = azure.Table.Operators.number(3.14);
    var expected = "3.14";
    assert(val === expected, "Expected '" + expected + "' got '" + val + "'");
  });

  test("azure.Table.Operators.bool (true)", function() {
    var val = azure.Table.Operators.bool(true);
    var expected = "true";
    assert(val === expected, "Expected '" + expected + "' got '" + val + "'");
  });

  test("azure.Table.Operators.bool (false)", function() {
    var val = azure.Table.Operators.bool(false);
    var expected = "false";
    assert(val === expected, "Expected '" + expected + "' got '" + val + "'");
  });

  test("azure.Table.Operators.bool (undefined)", function() {
    var val = azure.Table.Operators.bool(undefined);
    var expected = "false";
    assert(val === expected, "Expected '" + expected + "' got '" + val + "'");
  });

  test("azure.Table.Operators.bool (null)", function() {
    var val = azure.Table.Operators.bool(null);
    var expected = "false";
    assert(val === expected, "Expected '" + expected + "' got '" + val + "'");
  });

  test("azure.Table.Operators.date", function() {
    var d = new Date('2015-05-13T06:37:32.150Z');
    var val = azure.Table.Operators.date(d);
    var expected = "datetime'2015-05-13T06:37:32.150Z'";
    assert(val === expected, "Expected '" + expected + "' got '" + val + "'");
  });

  test("azure.Table.Operators.guid", function() {
    var uuid = 'de305d54-75b4-431b-adb2-eb6b9e546014';
    var val = azure.Table.Operators.guid(uuid);
    var expected = "guid'de305d54-75b4-431b-adb2-eb6b9e546014'";
    assert(val === expected, "Expected '" + expected + "' got '" + val + "'");
  });
});
