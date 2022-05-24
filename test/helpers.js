const taskcluster = require('taskcluster-client');

const credentials = {};
exports.credentials = credentials;

suiteSetup(async () => {
  credentials.accountId = process.env.AZURE_ACCOUNT;
  credentials.accessKey = process.env.AZURE_ACCOUNT_KEY;

  console.warn('Tests require live azure accounts and are disabled on CI. To test locally, please set AZURE_ACCOUNT and AZURE_ACCOUNT_KEY');

  if (credentials.accountId && credentials.accessKey) {
    return;
  }

  // load credentials from the secret if running in CI
  if (process.env.TASKCLUSTER_PROXY_URL) {
    console.log('loading credentials from secret via TASKCLUSTER_PROXY_URL');
    const client = new taskcluster.Secrets({rootUrl: process.env.TASKCLUSTER_PROXY_URL});
    const res = await client.get('project/taskcluster/testing/azure');
    credentials.accountId = res.secret.AZURE_ACCOUNT;
    credentials.accessKey = res.secret.AZURE_ACCOUNT_KEY;
    return;
  }

  console.error('set $AZURE_ACCOUNT and $AZURE_ACCOUNT_KEY to a testing Azure storage account.');
  // process.exit(1);
});
