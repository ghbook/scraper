/* eslint-disable prefer-destructuring */
/* eslint-disable no-case-declarations */
/* eslint-disable no-console */
import fs from 'fs';
import { join, dirname, extname } from 'path';
import pino from 'pino';
import PlaywrightClient from '../browserclient/PlaywrightClient';
import PuppeteerClient from '../browserclient/PuppeteerClient';
import CheerioClient from '../domclient/CheerioClient';
import JsdomClient from '../domclient/JsdomClient';
import Scraper, { ScrapeEvent, ScrapeOptions } from '../scraper/Scraper';
import KnexStorage from '../storage/knex/KnexStorage';
import { setLogger } from '../logger/Logger';

const defaultArgObj = {
  jsExecPath: null,
  version: false,
  logLevel: null,
  logDestination: null,
  config: null,
  overwrite: false,
  export: null,
  exportType: null,
  discover: false,
};

type ArgObjType = typeof defaultArgObj;

/**
 * Takes --arg1 val1 --arg2 process.argv array and creates a plain object {arg1: val1, arg2: val2}.
 * @param args - process.argv
 * @returns plain object with arguments as keys
 */
export function readArgs(args: string[]):Partial<ArgObjType> {
  // read and validate key
  const arg = args[0].trim();
  if (arg.indexOf('--') !== 0) throw new Error(`invalid argument ${arg}, try --${arg}`);
  const argKey = Object.keys(defaultArgObj).find(key => key.toLowerCase() === arg.slice(2).toLowerCase());
  if (!argKey) throw new Error(`unknown argument ${arg}`);

  // read arg value(s)
  let argVal;
  let i = 1;
  while (i < args.length) {
    // found arg value
    if (args[i].indexOf('--') === -1) {
      i += 1;
    }
    // found new key
    else {
      break;
    }
  }

  // no value found, arguments without value are boolean with default value true
  if (i === 1) {
    argVal = true;
  }
  // single value found, arg value is a scalar
  else if (i === 2) {
    argVal = args[1];
  }
  // multiple values found, arg value is an array
  else {
    argVal = args.slice(1, i);
  }

  const currObj:Partial<ArgObjType> = {
    [argKey]: argVal,
  };

  // more arguments to read
  if (i < args.length) {
    const nextObj = readArgs(args.slice(i));
    if (Object.keys(nextObj).includes(argKey)) throw new Error(`duplicate key ${argKey}`);
    return {
      ...currObj,
      ...nextObj,
    };
  }

  // no more arguments to read
  return currObj;
}

export function invokeVersion() {
  // get closest package.json
  const parentPath: string[] = [];
  while (!fs.existsSync(join(__dirname, ...parentPath, 'package.json'))) {
    parentPath.push('..');
  }

  // output version
  const packageFile = fs.readFileSync(join(__dirname, ...parentPath, 'package.json')).toString('utf-8');
  const { version } = JSON.parse(packageFile);
  console.log(`@get-set-fetch/scraper - v${version}`);
}

export function invokeLogger(argObj:ArgObjType) {
  const { logLevel, logDestination, jsExecPath } = argObj;

  if (logLevel && (typeof logLevel) !== 'string') throw new Error('invalid loglevel value');
  if (logDestination && (typeof logDestination) !== 'string') throw new Error('invalid logdestination value');

  console.log(`setting up logger - level: ${logLevel || 'default'}, destination: ${logDestination || 'console'}`);
  setLogger(
    {
      level: logLevel || 'warn',
    },
    logDestination ? pino.destination(join(dirname(jsExecPath), <string>logDestination)) : null,
  );
}

export function invokeScraper(argObj:ArgObjType) {
  const { config, overwrite, discover, jsExecPath } = argObj;

  if ((typeof config) !== 'string') throw new Error('invalid config path');
  const fullConfigPath = join(dirname(jsExecPath), config);
  if (!fs.existsSync(fullConfigPath)) throw new Error(`config path ${fullConfigPath} does not exist`);
  console.log(`using scrape configuration file ${fullConfigPath}`);

  const configFile = fs.readFileSync(fullConfigPath).toString('utf-8');
  const { storage: storageOpts, dom: domOpts, scrape: scrapeOpts, concurrency: concurrencyOpts, process: processOpts } = JSON.parse(configFile);

  if (!storageOpts) throw new Error('missing storage options');
  if (!storageOpts.client) throw new Error('missing storage client');

  let storage;
  switch (storageOpts.client) {
    case 'sqlite3':
      // generate full sqlite3 filepath relative to config file
      if (storageOpts.connection.filename !== ':memory:') {
        storageOpts.connection.filename = join(dirname(fullConfigPath), storageOpts.connection.filename);
        console.log(`using sqlite file ${storageOpts.connection.filename}`);
      }
    // eslint-disable-next-line no-fallthrough
    case 'mysql':
    case 'pg':
      storage = new KnexStorage(storageOpts);
      break;
    default:
      throw new Error(`invalid storage client ${storageOpts.client}`);
  }

  if (!domOpts) throw new Error('missing DOM options');
  if (!domOpts.client) throw new Error('missing DOM client');

  let domClient;
  switch (domOpts.client) {
    case 'cheerio':
      domClient = CheerioClient;
      break;
    case 'jsdom':
      domClient = JsdomClient;
      break;
    case 'puppeteer':
      domClient = new PuppeteerClient(domOpts);
      break;
    case 'playwright':
      domClient = new PlaywrightClient(domOpts);
      break;
    default:
      throw new Error(`invalid DOM client ${domOpts.client}`);
  }

  const scrapeOptions:ScrapeOptions = {
    // after scraping completes always close all remaining opened resources (browser, storage, ..)
    cleanup: {
      client: true,
      storage: true,
    },
    overwrite,
    discover,
  };

  const scraper = new Scraper(storage, domClient, scrapeOptions);

  if (argObj.export) {
    const exportPath = join(dirname(jsExecPath), argObj.export);
    if (!fs.existsSync(dirname(exportPath))) throw new Error(`export path ${dirname(exportPath)} does not exist`);
    console.log(`scraped data will be exported to ${exportPath}`);

    let { exportType } = argObj;
    // an export type was not explicitely defined, try to determine it based on export file extension
    if (!exportType) {
      const extName = extname(exportPath);
      switch (extName) {
        case '.csv':
          exportType = 'csv';
          break;
        case '.zip':
          exportType = 'zip';
          break;
        default:
          throw new Error('missing --exportType');
      }
    }

    scraper.addListener(ScrapeEvent.ProjectScraped, async () => {
      console.log(`exporting to ${exportPath}`);
      await scraper.export(exportPath, { type: exportType });
      console.log(`exporting to ${exportPath} complete`);
    });
  }

  scraper.addListener(ScrapeEvent.ProjectError, err => {
    console.log(err);
  });

  scraper.scrape(scrapeOpts, concurrencyOpts, processOpts);
}

export function invoke(argv: string[]) {
  const argObj:ArgObjType = {
    ...defaultArgObj,
    jsExecPath: argv[1],
    ...readArgs(argv.slice(2)),
  };

  if (argObj.version) {
    invokeVersion();
  }

  if (argObj.logLevel || argObj.logDestination) {
    invokeLogger(argObj);
  }

  if (argObj.config) {
    invokeScraper(argObj);
  }
}

export default function cli(args) {
  try {
    invoke(args);
  }
  catch (err) {
    console.log(err.toString());
  }
}