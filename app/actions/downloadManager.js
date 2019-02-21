import path from 'path';
import { message } from 'antd';
import { promisify } from 'util';
import axios from 'axios';
import makeDir from 'make-dir';
import fse from 'fs-extra';
import log from 'electron-log';
import Promise from 'bluebird';
import fs from 'fs';
import compressing from 'compressing';
import { downloadFile, downloadArr } from '../utils/downloader';
import {
  PACKS_PATH,
  INSTANCES_PATH,
  META_PATH,
  GDL_LEGACYJAVAFIXER_MOD_URL,
  CURSEMETA_API_URL
} from '../constants';
import vCompare from '../utils/versionsCompare';
import {
  extractAssets,
  extractMainJar,
  extractNatives,
  computeVanillaAndForgeLibraries
} from '../utils/getMCFilesList';
import { downloadMod, getModsList, createDoNotTouchFile } from '../utils/mods';
import { arraify } from '../utils/strings';
import { copyAssetsToLegacy } from '../utils/assets';

export const START_DOWNLOAD = 'START_DOWNLOAD';
export const CLEAR_QUEUE = 'CLEAR_QUEUE';
export const ADD_TO_QUEUE = 'ADD_TO_QUEUE';
export const DOWNLOAD_COMPLETED = 'DOWNLOAD_COMPLETED';
export const UPDATE_TOTAL_FILES_TO_DOWNLOAD = 'UPDATE_TOTAL_FILES_TO_DOWNLOAD';
export const UPDATE_PROGRESS = 'UPDATE_PROGRESS';

export function addToQueue(pack, version, forgeVersion = null) {
  return (dispatch, getState) => {
    const { downloadManager } = getState();
    dispatch({
      type: ADD_TO_QUEUE,
      payload: pack,
      version,
      forgeVersion
    });
    if (downloadManager.actualDownload === null) {
      dispatch({
        type: START_DOWNLOAD,
        payload: pack
      });
      dispatch(downloadPack(pack));
    }
  };
}

export function importTwitchProfile(pack, filePath) {
  return async (dispatch, getState) => {
    const { downloadManager } = getState();
    await compressing.zip.uncompress(
      filePath,
      path.join(INSTANCES_PATH, 'temp', pack)
    );
    const packInfo = JSON.parse(
      await promisify(fs.readFile)(
        path.join(INSTANCES_PATH, 'temp', pack, 'manifest.json')
      )
    );
    makeDir(path.join(PACKS_PATH, pack));
    const mcVersion = packInfo.minecraft.version;
    const addonID = packInfo.projectID;
    const forgeVersion = packInfo.minecraft.modLoaders[0].id.replace(
      'forge-',
      ''
    );
    dispatch({
      type: ADD_TO_QUEUE,
      payload: pack,
      version: mcVersion,
      forgeVersion,
      addonID
    });
    if (downloadManager.actualDownload === null) {
      dispatch({
        type: START_DOWNLOAD,
        payload: pack
      });
      dispatch(downloadPack(pack));
    }
  };
}

export function addCursePackToQueue(pack, addonID, fileID) {
  return async (dispatch, getState) => {
    const { downloadManager } = getState();
    const packURL = (await axios.get(
      `${CURSEMETA_API_URL}/direct/addon/${addonID}/file/${fileID}`
    )).data.downloadUrl;
    const tempPackPath = path.join(
      INSTANCES_PATH,
      'temp',
      path.basename(packURL)
    );
    await downloadFile(tempPackPath, packURL, () => {});
    await compressing.zip.uncompress(
      tempPackPath,
      path.join(INSTANCES_PATH, 'temp', pack)
    );
    const packInfo = JSON.parse(
      await promisify(fs.readFile)(
        path.join(INSTANCES_PATH, 'temp', pack, 'manifest.json')
      )
    );
    makeDir(path.join(PACKS_PATH, pack));
    const mcVersion = packInfo.minecraft.version;
    const forgeVersion = packInfo.minecraft.modLoaders[0].id.replace(
      'forge-',
      ''
    );
    dispatch({
      type: ADD_TO_QUEUE,
      payload: pack,
      version: mcVersion,
      forgeVersion,
      addonID
    });
    if (downloadManager.actualDownload === null) {
      dispatch({
        type: START_DOWNLOAD,
        payload: pack
      });
      dispatch(downloadPack(pack));
    }
  };
}

export function clearQueue() {
  // This needs to clear any instance that is already installed
  return (dispatch, getState) => {
    const { downloadManager } = getState();
    const completed = Object.keys(downloadManager.downloadQueue).filter(
      act => downloadManager.downloadQueue[act].status === 'Completed'
    );
    // It makes no sense to dispatch if no instance is to remove
    if (completed.length !== 0) {
      dispatch({
        type: CLEAR_QUEUE,
        payload: completed
      });
    }
  };
}

export function downloadPack(pack) {
  return async (dispatch, getState) => {
    const { downloadManager, packCreator } = getState();
    const currPack = downloadManager.downloadQueue[pack];
    let vnlJSON = null;
    try {
      vnlJSON = JSON.parse(
        await promisify(fs.readFile)(
          path.join(
            META_PATH,
            'net.minecraft',
            currPack.version,
            `${currPack.version}.json`
          )
        )
      );
    } catch (err) {
      const versionURL = packCreator.versionsManifest.find(
        v => v.id === currPack.version
      ).url;
      vnlJSON = (await axios.get(versionURL)).data;
      await makeDir(path.join(META_PATH, 'net.minecraft', currPack.version));
      await promisify(fs.writeFile)(
        path.join(
          META_PATH,
          'net.minecraft',
          currPack.version,
          `${currPack.version}.json`
        ),
        JSON.stringify(vnlJSON)
      );
    }

    let forgeJSON = null;

    const assets = await extractAssets(vnlJSON);
    const mainJar = await extractMainJar(vnlJSON);

    if (currPack.forgeVersion !== null) {
      try {
        forgeJSON = JSON.parse(
          await promisify(fs.readFile)(
            path.join(
              META_PATH,
              'net.minecraftforge',
              `forge-${currPack.forgeVersion}`,
              `forge-${currPack.forgeVersion}.json`
            )
          )
        );
        await promisify(fs.access)(
          path.join(
            INSTANCES_PATH,
            'libraries',
            ...arraify(forgeJSON.libraries[0].name)
          )
        );
      } catch (err) {
        const { data } = await axios.get(
          `https://addons-ecs.forgesvc.net/api/minecraft/modloader/forge-${
            currPack.forgeVersion
          }`
        );

        forgeJSON =
          JSON.parse(data.versionJson) || JSON.parse(data.additionalFilesJson);

        await downloadFile(
          path.join(
            INSTANCES_PATH,
            'libraries',
            ...arraify(forgeJSON.libraries[0].name)
          ),
          data.downloadUrl,
          p => {
            dispatch({
              type: UPDATE_PROGRESS,
              payload: { pack, percentage: ((p * 18) / 100).toFixed(0) }
            });
          }
        );

        await makeDir(
          path.dirname(
            path.join(
              INSTANCES_PATH,
              'libraries',
              ...arraify(forgeJSON.libraries[0].name)
            )
          )
        );
        await makeDir(
          path.join(
            META_PATH,
            'net.minecraftforge',
            `forge-${currPack.forgeVersion}`
          )
        );
        await promisify(fs.writeFile)(
          path.join(
            META_PATH,
            'net.minecraftforge',
            `forge-${currPack.forgeVersion}`,
            `forge-${currPack.forgeVersion}.json`
          ),
          JSON.stringify(forgeJSON)
        );
      }
    }

    const libraries = await computeVanillaAndForgeLibraries(vnlJSON, forgeJSON);

    // This is the main config file for the instance
    await makeDir(path.join(PACKS_PATH, pack));

    const thumbnailURL = currPack.addonID
      ? (await axios.get(
          `${CURSEMETA_API_URL}/direct/addon/${currPack.addonID}`
        )).data.attachments[0].thumbnailUrl
      : null;

    await promisify(fs.writeFile)(
      path.join(PACKS_PATH, pack, 'config.json'),
      JSON.stringify({
        version: currPack.version,
        forgeVersion:
          currPack.forgeVersion === null
            ? null
            : `forge-${currPack.forgeVersion}`,
        timePlayed: 0
      })
    );

    // We download the legacy java fixer if needed
    const legacyJavaFixer =
      vCompare(currPack.forgeVersion, '10.13.1.1217') === -1
        ? {
            url: GDL_LEGACYJAVAFIXER_MOD_URL,
            path: path.join(PACKS_PATH, pack, 'mods', 'LJF.jar')
          }
        : null;

    // Here we work on the mods
    await createDoNotTouchFile(pack);

    try {
      const manifest = JSON.parse(
        await promisify(fs.readFile)(
          path.join(INSTANCES_PATH, 'temp', pack, 'manifest.json')
        )
      );
      const overrideFiles = await promisify(fs.readdir)(
        path.join(INSTANCES_PATH, 'temp', pack, 'overrides')
      );
      await Promise.all(
        overrideFiles.map(async item => {
          await fse.move(
            path.join(INSTANCES_PATH, 'temp', pack, 'overrides', item),
            path.join(PACKS_PATH, pack, item),
            { overwrite: true }
          );
        })
      );
      await fse.move(
        path.join(INSTANCES_PATH, 'temp', pack, 'manifest.json'),
        path.join(PACKS_PATH, pack, 'manifest.json')
      );
      // await fse.remove(path.join(INSTANCES_PATH, 'temp', pack));

      let modsDownloaded = 0;
      let modsManifest = [];
      await Promise.map(
        manifest.files,
        async mod => {
          modsDownloaded += 1;
          const modManifest = await downloadMod(
            mod.projectID,
            mod.fileID,
            null,
            pack
          );
          modsManifest = modsManifest.concat(modManifest);
          dispatch({
            type: UPDATE_PROGRESS,
            payload: {
              pack,
              percentage: (
                (modsDownloaded * 12) / manifest.files.length +
                18
              ).toFixed(0)
            }
          });
        },
        { concurrency: 4 }
      );

      // Write the mods list to a file
      await promisify(fs.writeFile)(
        path.join(PACKS_PATH, pack, 'mods.json'),
        JSON.stringify(modsManifest)
      );
    } catch (err) {
      log.error(err);
    }

    const totalFiles = libraries.length + assets.length + mainJar.length;

    dispatch({
      type: UPDATE_TOTAL_FILES_TO_DOWNLOAD,
      payload: {
        pack,
        total: totalFiles
      }
    });

    const updatePercentage = downloaded => {
      const actPercentage = ((downloaded * 70) / totalFiles + 30).toFixed(0);
      if (currPack.percentage !== actPercentage)
        return dispatch({
          type: UPDATE_PROGRESS,
          payload: {
            pack,
            percentage: actPercentage
          }
        });
    };
    if (thumbnailURL !== null)
      await downloadFile(
        path.join(PACKS_PATH, pack, 'thumbnail.png'),
        thumbnailURL,
        () => {}
      );

    const allFiles =
      legacyJavaFixer !== null
        ? [...libraries, ...assets, ...mainJar, legacyJavaFixer]
        : [...libraries, ...assets, ...mainJar];

    await downloadArr(allFiles, updatePercentage, pack);

    if (vnlJSON.assets === 'legacy') {
      await copyAssetsToLegacy(assets);
    }
    await extractNatives(libraries.filter(lib => 'natives' in lib), pack);

    dispatch({
      type: DOWNLOAD_COMPLETED,
      payload: pack
    });
    message.success(`${pack} has been downloaded!`);
    dispatch(addNextPackToActualDownload());
  };
}

function addNextPackToActualDownload() {
  return (dispatch, getState) => {
    const { downloadManager } = getState();
    const queueArr = Object.keys(downloadManager.downloadQueue);
    queueArr.some(pack => {
      if (downloadManager.downloadQueue[pack].status !== 'Completed') {
        dispatch({
          type: START_DOWNLOAD,
          payload: pack
        });
        dispatch(downloadPack(pack));
        return true;
      }
      return false;
    });
  };
}
