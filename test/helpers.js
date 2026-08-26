export const credentials = {};

// The live Azure suites (blob/queue/table_test.js) are `suite.skip`ped, so these
// credentials are currently unused. They are kept so the suites can be run locally
// by dropping the `.skip` and setting the two variables below.
suiteSetup(() => {
  credentials.accountId = process.env.AZURE_ACCOUNT;
  credentials.accessKey = process.env.AZURE_ACCOUNT_KEY;

  if (!credentials.accountId || !credentials.accessKey) {
    console.warn('Live Azure suites are skipped; set $AZURE_ACCOUNT and $AZURE_ACCOUNT_KEY to run them locally.');
  }
});
