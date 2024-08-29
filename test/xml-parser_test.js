import assert from 'assert';
import * as xml from '../lib/xml-parser.js';

// the libxmljs implementation gets confused by whitespace nodes between
// elements, which are added below for readability, so strip them.
const stripWS = xml =>
  xml.replace(/>[ \n]*</g, '><');

suite('xml-parser', function() {
  test('parseError with message and code', function() {
    const payload = '<?xml version="1.0" ' +        
      'encoding="utf-8"?><Error><Code>ConditionNotMet</Code><Message>The ' +
      'condition specified using HTTP conditional header(s) is not ' +
      'met.\nRequestId:8775fa29-201e-00d0-1b1a-2eda27000000\n' +
      'Time:2019-06-29T01:35:15.5670223Z</Message></Error>' ;
    assert.deepEqual(xml.parseError({payload}), {
      code: 'ConditionNotMet',
      message: 'The condition specified using HTTP conditional header(s) is not met.\n' +
        'RequestId:8775fa29-201e-00d0-1b1a-2eda27000000\nTime:2019-06-29T01:35:15.5670223Z',
      detail: undefined,
    });
  });

  test('parseError with message without code (5xx)', function() {
    const payload = '<?xml version="1.0" ' +        
      'encoding="utf-8"?><Error><Message>The ' +
      'condition specified using HTTP conditional header(s) is not ' +
      'met.\nRequestId:8775fa29-201e-00d0-1b1a-2eda27000000\n' +
      'Time:2019-06-29T01:35:15.5670223Z</Message></Error>' ;
    assert.deepEqual(xml.parseError({payload, statusCode: 501}), {
      code: 'InternalErrorWithoutCode',
      message: 'The condition specified using HTTP conditional header(s) is not met.\n' +
        'RequestId:8775fa29-201e-00d0-1b1a-2eda27000000\nTime:2019-06-29T01:35:15.5670223Z',
      detail: undefined,
    });
  });

  test('parseError with message without code (4xx)', function() {
    const payload = '<?xml version="1.0" ' +        
      'encoding="utf-8"?><Error><Message>The ' +
      'condition specified using HTTP conditional header(s) is not ' +
      'met.\nRequestId:8775fa29-201e-00d0-1b1a-2eda27000000\n' +
      'Time:2019-06-29T01:35:15.5670223Z</Message></Error>' ;
    assert.deepEqual(xml.parseError({payload, statusCode: 401}), {
      code: 'ErrorWithoutCode',
      message: 'The condition specified using HTTP conditional header(s) is not met.\n' +
        'RequestId:8775fa29-201e-00d0-1b1a-2eda27000000\nTime:2019-06-29T01:35:15.5670223Z',
      detail: undefined,
    });
  });

  test('parseError without message', function() {
    const payload =
      '<?xml version="1.0" encoding="utf-8"?><Error><Code>ConditionNotMet</Code></Error>';
    assert.deepEqual(xml.parseError({payload, statusCode: 401}), {
      code: 'ConditionNotMet',
      message: `No error message given, in payload '${payload}'`,
      detail: undefined,
    });
  });

  test('parseError with detail', function() {
    const payload = '<?xml version="1.0" ' +
      'encoding="utf-8"?><Error><Code>AuthenticationFailed</Code><Message>Server ' +
      'failed to authenticate the request.</Message><AuthenticationErrorDetail>Signed ' +
      'permission must be specified in signature or SAS ' +
      'identifier</AuthenticationErrorDetail></Error>';
    assert.deepEqual(xml.parseError({payload, statusCode: 401}), {
      code: 'AuthenticationFailed',
      message: 'Server failed to authenticate the request.',
      detail: 'Signed permission must be specified in signature or SAS identifier',
    });
  });

  test('queueParseListQueues plural', function() {
    const payload = stripWS(`<?xml version="1.0" encoding="utf-8"?>
      <EnumerationResults ServiceEndpoint="https://jungle.queue.core.windows.net/">
        <Prefix>fast-azure-test-que</Prefix>
        <Queues>
          <Queue>
            <Name>fast-azure-test-queue</Name>
            <Metadata>
              <purpose>testing</purpose>
            </Metadata>
          </Queue>
          <Queue>
            <Name>fast-azure-test-queue-foo</Name>
            <Metadata>
              <purpose>testing</purpose>
            </Metadata>
          </Queue>
          <Queue>
            <Name>fast-azure-test-queue-v2</Name>
            <Metadata>
              <applicationName>fast-azure- storage</applicationName>
              <purpose>testing</purpose>
            </Metadata>
          </Queue>
        </Queues>
        <NextMarker />
        <Marker>/jungle/auth-test-1dfb1916-46fc-46f4-aaaf-858f12d6fc65</Marker>
        <MaxResults>10</MaxResults>
      </EnumerationResults>`);
    assert.deepEqual(xml.queueParseListQueues({payload}), {
      nextMarker: '',
      marker: '/jungle/auth-test-1dfb1916-46fc-46f4-aaaf-858f12d6fc65',
      maxResults: 10,
      prefix: 'fast-azure-test-que',
      queues: [
        {
          metadata: {purpose: 'testing'},
          name: 'fast-azure-test-queue'
        },
        {
          metadata: {purpose: 'testing'},
          name: 'fast-azure-test-queue-foo',
        },
        {
          metadata: {
            applicationName: 'fast-azure- storage',
            purpose: 'testing',
          },
          name: 'fast-azure-test-queue-v2',
        },
      ],
    });
  });

  test('queueParsePeekMessages single', function() {
    const payload = stripWS(`<?xml version="1.0" encoding="utf-8"?>
      <QueueMessagesList>
        <QueueMessage>
          <MessageId>ff755a36-441a-468c-b35c-55b199cafed3</MessageId>
          <InsertionTime>Sat, 29 Jun 2019 02:54:44 GMT</InsertionTime>
          <ExpirationTime>Sat, 29 Jun 2019 02:56:44 GMT</ExpirationTime>
          <DequeueCount>0</DequeueCount>
          <MessageText>my-message3</MessageText>
        </QueueMessage>
      </QueueMessagesList>`);
    assert.deepEqual(xml.queueParsePeekMessages({payload}), [
      {
        dequeueCount: 0,
        expirationTime: new Date('2019-06-29T02:56:44.000Z'),
        insertionTime: new Date('2019-06-29T02:54:44.000Z'),
        messageId: 'ff755a36-441a-468c-b35c-55b199cafed3',
        messageText: 'my-message3'
      }
    ]);
  });

  test('queueParseGetMessages none', function() {
    const payload = stripWS(`<?xml version="1.0" encoding="utf-8"?>
      <QueueMessagesList>
      </QueueMessagesList>`);
    assert.deepEqual(xml.queueParseGetMessages({payload}), []);
  });

  test('queueParseGetMessages single', function() {
    const payload = stripWS(`<?xml version="1.0" encoding="utf-8"?>
      <QueueMessagesList>
        <QueueMessage>
          <MessageId>60986a2f-759e-4e90-9efa-8f313229eeeb</MessageId>
          <InsertionTime>Sat, 29 Jun 2019 02:58:29 GMT</InsertionTime>
          <ExpirationTime>Sat, 29 Jun 2019 03:00:29 GMT</ExpirationTime>
          <PopReceipt>AgAAAAMAAAAAAAAANr7kziYu1QE=</PopReceipt>
          <TimeNextVisible>Sat, 29 Jun 2019 03:00:29 GMT</TimeNextVisible>
          <DequeueCount>1</DequeueCount>
          <MessageText>my-message5</MessageText>
        </QueueMessage>
      </QueueMessagesList>`);
    assert.deepEqual(xml.queueParseGetMessages({payload}), [
      {
        dequeueCount: 1,
        expirationTime: new Date('2019-06-29T03:00:29.000Z'),
        insertionTime: new Date('2019-06-29T02:58:29.000Z'),
        messageId: '60986a2f-759e-4e90-9efa-8f313229eeeb',
        messageText: 'my-message5',
        popReceipt: 'AgAAAAMAAAAAAAAANr7kziYu1QE=',
        timeNextVisible: new Date('2019-06-29T03:00:29.000Z'),
      }
    ]);
  });

  test('blobParseListContainers single', function() {
    const payload = stripWS(`<?xml version="1.0" encoding="utf-8"?>
      <EnumerationResults ServiceEndpoint="https://jungle.blob.core.windows.net/">
        <Prefix>fast-azure-blob-container</Prefix>
        <Containers>
          <Container>
            <Name>fast-azure-blob-container-delete-with-condition</Name>
            <Properties>
              <Last-Modified>Sat, 29 Jun 2019 01:44:16 GMT</Last-Modified>
              <Etag>"0x8D6FC334BEDB92B"</Etag>
              <LeaseStatus>unlocked</LeaseStatus>
              <LeaseState>available</LeaseState>
              <LeaseDuration>a week</LeaseDuration>
              <PublicAccess>10</PublicAccess>
            </Properties>
            <Metadata>
              <scope>test</scope>
            </Metadata>
          </Container>
        </Containers>
        <Marker>/jungle/mkr</Marker>
        <NextMarker>/jungle/auth-test-1dfb1916-46fc-46f4-aaaf-858f12d6fc65</NextMarker>
        <MaxResults>10</MaxResults>
      </EnumerationResults>`);
    assert.deepEqual(xml.blobParseListContainers({payload}), {
      containers: [
        {
          metadata: {
            scope: 'test'
          },
          name: 'fast-azure-blob-container-delete-with-condition',
          properties: {
            eTag: '"0x8D6FC334BEDB92B"',
            lastModified: 'Sat, 29 Jun 2019 01:44:16 GMT',
            leaseState: 'available',
            leaseStatus: 'unlocked',
            leaseDuration: 'a week',
            publicAccessLevel: '10'
          }
        }
      ],
      marker: '/jungle/mkr',
      nextMarker: '/jungle/auth-test-1dfb1916-46fc-46f4-aaaf-858f12d6fc65',
      maxResults: 10,
      prefix: 'fast-azure-blob-container'
    });
  });

  test('blobParseListContainers plural', function() {
    const payload = stripWS(`<?xml version="1.0" encoding="utf-8"?>
    <EnumerationResults ServiceEndpoint="https://jungle.blob.core.windows.net/">
      <Prefix>fast-azure-blob-container</Prefix>
      <Containers>
        <Container>
          <Name>fast-azure-blob-container-with-metadata</Name>
          <Properties>
            <Last-Modified>Sun, 30 Jun 2019 20:16:29 GMT</Last-Modified>
            <Etag>"0x8D6FD97D62F6E79"</Etag>
            <LeaseStatus>unlocked</LeaseStatus>
            <LeaseState>available</LeaseState>
          </Properties>
        </Container>
        <Container>
          <Name>fast-azure-blob-container-with-properties</Name>
          <Properties>
            <Last-Modified>Sun, 30 Jun 2019 20:16:32 GMT</Last-Modified>
            <Etag>"0x8D6FD97D7B2EAA9"</Etag>
            <LeaseStatus>unlocked</LeaseStatus>
            <LeaseState>available</LeaseState>
          </Properties>
        </Container>
        <Container>
          <Name>fast-azure-blob-container-without-metadata</Name>
          <Properties>
            <Last-Modified>Sun, 30 Jun 2019 20:16:29 GMT</Last-Modified>
            <Etag>"0x8D6FD97D6353C2D"</Etag>
            <LeaseStatus>unlocked</LeaseStatus>
            <LeaseState>available</LeaseState>
          </Properties>
        </Container>
      </Containers>
      <NextMarker />
    </EnumerationResults>`);
    assert.deepEqual(xml.blobParseListContainers({payload}), {
      containers: [
        { 
          name: 'fast-azure-blob-container-with-metadata',
          properties:
          {
            eTag: '"0x8D6FD97D62F6E79"',
            lastModified: 'Sun, 30 Jun 2019 20:16:29 GMT',
            leaseStatus: 'unlocked',
            leaseState: 'available',
          },
          metadata: undefined,
        },
        {
          name: 'fast-azure-blob-container-with-properties',
          properties:
          { eTag: '"0x8D6FD97D7B2EAA9"',
            lastModified: 'Sun, 30 Jun 2019 20:16:32 GMT',
            leaseStatus: 'unlocked',
            leaseState: 'available',
          },
          metadata: undefined,
        },
        {
          name: 'fast-azure-blob-container-without-metadata',
          properties:
          {
            eTag: '"0x8D6FD97D6353C2D"',
            lastModified: 'Sun, 30 Jun 2019 20:16:29 GMT',
            leaseStatus: 'unlocked',
            leaseState: 'available',
          },
          metadata: undefined,
        },
      ],
      prefix: 'fast-azure-blob-container',
      nextMarker: ''
    });
  });

  test('blobParseContainerACL singular', function() {
    const payload = stripWS(`<?xml version="1.0" encoding="utf-8"?>
      <SignedIdentifiers>
        <SignedIdentifier>
          <Id>1</Id>
          <AccessPolicy>
            <Start>2019-06-29T01:47:09.0000000Z</Start>
            <Expiry>2019-06-30T01:47:09.0000000Z</Expiry>
            <Permission>rwacl</Permission>
          </AccessPolicy>
        </SignedIdentifier>
      </SignedIdentifiers>`);
    assert.deepEqual(xml.blobParseContainerACL({payload}), [
      {
        id: '1',
        permission: {
          add: true,
          create: true,
          delete: false,
          list: true,
          read: true,
          write: true
        },
        start: '2019-06-29T01:47:09.0000000Z',
        expiry: '2019-06-30T01:47:09.0000000Z'
      }
    ]);
  });

  test('blobParseContainerACL plural', function() {
    const payload = stripWS(`<?xml version="1.0" encoding="utf-8"?>
      <SignedIdentifiers>
        <SignedIdentifier>
          <Id>1</Id>
          <AccessPolicy>
            <Start>2019-06-29T01:47:09.0000000Z</Start>
            <Permission>rwacl</Permission>
          </AccessPolicy>
        </SignedIdentifier>
        <SignedIdentifier>
          <Id>2</Id>
          <AccessPolicy>
            <Start>2019-06-29T01:47:09.0000000Z</Start>
          </AccessPolicy>
        </SignedIdentifier>
      </SignedIdentifiers>`);
    assert.deepEqual(xml.blobParseContainerACL({payload}), [
      {
        id: '1',
        permission: {
          add: true,
          create: true,
          delete: false,
          list: true,
          read: true,
          write: true
        },
        start: '2019-06-29T01:47:09.0000000Z'
      },
      {
        id: '2',
        permission: {
          add: false,
          create: false,
          delete: false,
          list: false,
          read: false,
          write: false
        },
        start: '2019-06-29T01:47:09.0000000Z'
      }
    ]);
  });

  test('blobParseListBlobs none', function() {
    const payload = stripWS(`<?xml version="1.0" encoding="utf-8"?>
      <EnumerationResults ServiceEndpoint="https://jungle.blob.core.windows.net/" ContainerName="fast-azure-blob-container-with-metadata">
      <Blobs />
      <NextMarker />
    </EnumerationResults>`);
    assert.deepEqual(xml.blobParseListBlobs({payload}), {
      blobs: [],
      nextMarker: '',
    });
  });

  test('blobParseListBlobs plural', function() {
    const payload = stripWS(`<?xml version="1.0" encoding="utf-8"?>
      <EnumerationResults ServiceEndpoint="https://jungle.blob.core.windows.net/" ContainerName="fast-azure-blob-container-with-blobs">
        <Prefix>tempBlockBlob</Prefix>
        <Blobs>
          <Blob>
            <Name>tempBlockBlob_append_block_with_conditional_headers</Name>
            <Properties>
              <Last-Modified>Sat, 29 Jun 2019 02:19:56 GMT</Last-Modified>
              <Etag>0x8D6FC38476C2BB0</Etag>
              <Content-Length>4</Content-Length>
              <Content-Type>application/octet-stream</Content-Type>
              <Content-Encoding />
              <Content-Language />
              <Content-MD5 />
              <Cache-Control />
              <Content-Disposition />
              <BlobType>AppendBlob</BlobType>
              <LeaseStatus>unlocked</LeaseStatus>
              <LeaseState>available</LeaseState>
              <ServerEncrypted>true</ServerEncrypted>
            </Properties>
          </Blob>
          <Blob>
            <Name>tempBlockBlob_if_none_matching_conditional_header</Name>
            <Properties>
              <Last-Modified>Sat, 29 Jun 2019 02:19:54 GMT</Last-Modified>
              <Etag>0x8D6FC384649113A</Etag>
              <Content-Length>11</Content-Length>
              <Content-Type>application/octet-stream</Content-Type>
              <Content-Encoding />
              <Content-Language />
              <Content-MD5>PiWWCnnbxptnTNTsZ6csYg==</Content-MD5>
              <Cache-Control />
              <Content-Disposition />
              <BlobType>BlockBlob</BlobType>
              <LeaseStatus>unlocked</LeaseStatus>
              <LeaseState>available</LeaseState>
              <ServerEncrypted>true</ServerEncrypted>
            </Properties>
            <Metadata>
              <purpose>testing</purpose>
            </Metadata>
          </Blob>
        </Blobs>
    </EnumerationResults>`);

    assert.deepEqual(xml.blobParseListBlobs({payload}), {
      blobs: [{
        cacheControl: '',
        contentEncoding: '',
        contentLanguage: '',
        contentLength: '4',
        contentMD5: '',
        contentType: 'application/octet-stream',
        eTag: '0x8D6FC38476C2BB0',
        lastModified: 'Sat, 29 Jun 2019 02:19:56 GMT',
        leaseState: 'available',
        leaseStatus: 'unlocked',
        name: 'tempBlockBlob_append_block_with_conditional_headers',
        serverEncrypted: 'true',
        type: 'AppendBlob'
      }, {
        cacheControl: '',
        contentEncoding: '',
        contentLanguage: '',
        contentLength: '11',
        contentMD5: 'PiWWCnnbxptnTNTsZ6csYg==',
        contentType: 'application/octet-stream',
        eTag: '0x8D6FC384649113A',
        lastModified: 'Sat, 29 Jun 2019 02:19:54 GMT',
        leaseState: 'available',
        leaseStatus: 'unlocked',
        name: 'tempBlockBlob_if_none_matching_conditional_header',
        serverEncrypted: 'true',
        type: 'BlockBlob',
        metadata: {purpose: 'testing'},
      }],
      prefix: 'tempBlockBlob'
    });
  });

  test('blobParseListBlock empty', function() {
    const payload = stripWS(`<?xml version="1.0" encoding="utf-8"?>
      <BlockList>
        <CommittedBlocks />
        <UncommittedBlocks />
      </BlockList>`);

    assert.deepEqual(xml.blobParseListBlock({payload}), {
      committedBlocks: [],
      uncommittedBlocks: [],
    });
  });

  test('blobParseListBlock singular', function() {
    const payload = stripWS(`<?xml version="1.0" encoding="utf-8"?>
      <BlockList>
        <CommittedBlocks>
          <Block>
            <Name>ZmFzdGF6dXJlLTAwMQ==</Name>
            <Size>574</Size>
          </Block>
        </CommittedBlocks>
        <UncommittedBlocks>
          <Block>
            <Name>ZmFzdGF6dXJlLTAwMg==</Name>
            <Size>163</Size>
          </Block>
        </UncommittedBlocks>
      </BlockList>`);

    assert.deepEqual(xml.blobParseListBlock({payload}), {
      committedBlocks: [
        {blockId: 'ZmFzdGF6dXJlLTAwMQ==', size: '574'}
      ],
      uncommittedBlocks: [
        {blockId: 'ZmFzdGF6dXJlLTAwMg==', size: '163'}
      ],
    });
  });

  test('blobParseListBlock plural', function() {
    const payload = stripWS(`<?xml version="1.0" encoding="utf-8"?>
      <BlockList>
        <CommittedBlocks>
          <Block>
            <Name>AmFzdGF6dXJlLTAwMQ==</Name>
            <Size>574</Size>
          </Block>
          <Block>
            <Name>ZmFzdGF6dXJlLTAwMQ==</Name>
            <Size>575</Size>
          </Block>
        </CommittedBlocks>
        <UncommittedBlocks>
          <Block>
            <Name>AmFzdGF6dXJlLTAwMg==</Name>
            <Size>163</Size>
          </Block>
          <Block>
            <Name>ZmFzdGF6dXJlLTAwMg==</Name>
            <Size>164</Size>
          </Block>
        </UncommittedBlocks>
      </BlockList>`);

    assert.deepEqual(xml.blobParseListBlock({payload}), {
      committedBlocks: [
        {blockId: 'AmFzdGF6dXJlLTAwMQ==', size: '574'},
        {blockId: 'ZmFzdGF6dXJlLTAwMQ==', size: '575'}
      ],
      uncommittedBlocks: [
        {blockId: 'AmFzdGF6dXJlLTAwMg==', size: '163'},
        {blockId: 'ZmFzdGF6dXJlLTAwMg==', size: '164'}
      ],
    });
  });

  test('blobParseServiceProperties singular', function() {
    const payload = stripWS(`<?xml version="1.0" encoding="utf-8"?>
      <StorageServiceProperties>
        <Logging>
          <Version>1.0</Version>
          <Read>true</Read>
          <Write>true</Write>
          <Delete>true</Delete>
          <RetentionPolicy>
            <Enabled>true</Enabled>
            <Days>80</Days>
          </RetentionPolicy>
        </Logging>
        <HourMetrics>
          <Version>1.0</Version>
          <Enabled>false</Enabled>
          <RetentionPolicy>
            <Enabled>false</Enabled >
          </RetentionPolicy>
        </HourMetrics>
        <MinuteMetrics>
          <Version>1.0</Version>
          <Enabled>true</Enabled>
          <IncludeAPIs>false</IncludeAPIs>
          <RetentionPolicy>
            <Enabled>true</Enabled>
            <Days>1</Days>
          </RetentionPolicy>
        </MinuteMetrics>
        <Cors>
          <CorsRule>
            <AllowedMethods>POST</AllowedMethods>
            <AllowedOrigins>*</AllowedOrigins>
            <AllowedHeaders />
            <ExposedHeaders>content-length</ExposedHeaders>
            <MaxAgeInSeconds>300</MaxAgeInSeconds>
          </CorsRule>
        </Cors>
      </StorageServiceProperties>`);

    assert.deepEqual(xml.blobParseServiceProperties({payload}), {
      corsRules: [
        {
          allowedHeaders: '',
          allowedMethods: 'POST',
          allowedOrigins: '*',
          exposedHeaders: 'content-length',
          maxAgeInSeconds: '300',
        },
      ],
      hourMetrics: {
        enabled: 'false',
        retentionPolicy: {enabled: 'false'},
        version: '1.0',
      },
      logging: {
        delete: 'true',
        read: 'true',
        retentionPolicy: {days: '80', enabled: 'true'},
        version: '1.0',
        write: 'true',
      },
      minuteMetrics: {
        enabled: 'true',
        includeAPIs: 'false',
        retentionPolicy: {days: '1', enabled: 'true'},
        version: '1.0',
      }
    });
  });
});
