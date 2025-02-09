import * as qrcode from 'qrcode-terminal';
import { from, Observable, race } from 'rxjs';
import {EvEmitter} from './events'
import { screenshot } from './initializer'
import { ConfigObject } from '../api/model';
import { Page, JSHandle} from 'puppeteer';
const timeout = ms =>  new Promise(resolve => setTimeout(resolve, ms, 'timeout'));

/**
 * Validates if client is authenticated
 * @returns true if is authenticated, false otherwise
 * @param waPage
 */
export const isAuthenticated = (waPage: Page) : Promise<unknown> => race(needsToScan(waPage), isInsideChat(waPage), sessionDataInvalid(waPage)).toPromise();

export const needsToScan = (waPage: Page) : Observable<unknown> => {
  return from(new Promise(async resolve  => {
    try {
    await Promise.race([
      waPage.waitForFunction('checkQrRefresh()',{ timeout: 0, polling: 1000 }).catch(()=>{}),
      await waPage
        .waitForSelector('body > div > div > .landing-wrapper', {
          timeout: 0
        }).catch(()=>resolve(true))
    ]).catch(()=>{})
    await waPage.waitForSelector("canvas[aria-label='Scan me!']", { timeout: 0 }).catch(()=>{})
      resolve(false)
    } catch (error) {
    console.log("needsToScan -> error", error)
    }
  }))
};

export const isInsideChat = (waPage: Page) : Observable<boolean> => {
  return from(
    waPage
      .waitForFunction(
        "!!window.WA_AUTHENTICATED || (document.getElementsByClassName('app')[0] && document.getElementsByClassName('app')[0].attributes && !!document.getElementsByClassName('app')[0].attributes.tabindex) || (document.getElementsByClassName('two')[0] && document.getElementsByClassName('two')[0].attributes && !!document.getElementsByClassName('two')[0].attributes.tabindex)",
        { timeout: 0 }
      )
      .then(() => true)
  );
};

export const sessionDataInvalid = async (waPage: Page) : Promise<string> => {
  await waPage
    .waitForFunction(
      '!window.getQrPng',
      { timeout: 0, polling: 'mutation' }
    )
    //if the code reaches here it means the browser was refreshed. Nuke the session data and restart `create`
    return 'NUKE';
}

export const phoneIsOutOfReach = async (waPage: Page) : Promise<boolean>  => {
  return await waPage
    .waitForFunction(
      'document.querySelector("body").innerText.includes("Trying to reach phone")',
      { timeout: 0, polling: 'mutation' }
    )
    .then(()=>true)
    .catch(()=>false);
} ;

export async function smartQr(waPage: Page, config?: ConfigObject) : Promise<boolean | void>{
    const evalResult = await waPage.evaluate("window.Store && window.Store.State")
    if (evalResult === false) {
      console.log('Seems as though you have been TOS_BLOCKed, unable to refresh QR Code. Please see https://github.com/open-wa/wa-automate-nodejs#best-practice for information on how to prevent this from happeing. You will most likely not get a QR Code');
      if (config.throwErrorOnTosBlock) throw new Error('TOSBLOCK');
    }

  const isAuthed = await isAuthenticated(waPage);
  if(isAuthed) return true;
  const grabAndEmit = async (qrData) => {
    const qrCode = await waPage.evaluate(`getQrPng()`);
    qrEv.emit(qrCode);
    if(!config.qrLogSkip) qrcode.generate(qrData,{small: true});
    else console.log(`New QR Code generated. Not printing in console because qrLogSkip is set to true`)
  }
  const qrEv = new EvEmitter(config.sessionId || 'session','qr');

  const _hasDefaultStateYet = await waPage.evaluate("window.Store &&  window.Store.State && window.Store.State.default")
  if(!_hasDefaultStateYet) {
    //expecting issue, take a screenshot then wait a few seconds before continuing
      await timeout(2000);
  }

  return new Promise(async resolve => {
    const funcName = '_smartQr';
    const fn = async (qrData) => {
      if(qrData==='QR_CODE_SUCCESS') return resolve(await isInsideChat(waPage).toPromise())
      grabAndEmit(qrData)
    }
    const set = () => waPage.evaluate(({funcName}) => {
      //@ts-ignore
      return window['smartQr'] ? window[`smartQr`](obj => window[funcName](obj)) : false
    },{funcName});
    await waPage.exposeFunction(funcName, (obj: any) =>fn(obj)).then(set).catch(async e=>{
      //if an error occurs during the qr launcher then take a screenshot.
      await screenshot(waPage);
      console.log("qr -> e", e);
    })
    const firstQr = await waPage.evaluate(`document.querySelector("canvas[aria-label='Scan me!']")?document.querySelector("canvas[aria-label='Scan me!']").parentElement.getAttribute("data-ref"):false`);
    await grabAndEmit(firstQr);
  })
}