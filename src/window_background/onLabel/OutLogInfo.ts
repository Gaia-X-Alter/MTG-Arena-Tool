import _ from "lodash";

import { ARENA_MODE_IDLE } from "../../shared/constants";
import db from "../../shared/database";
import playerData from "../../shared/player-data";
import LogEntry from "../../types/logDecoder";
import { LogInfo } from "../../types/log";
import { MatchGameStats } from "../../types/currentMatch";

import globals from "../globals";
import { ipc_send as ipcSend } from "../backgroundUtil";

import getNameBySeat from "../getNameBySeat";
import actionLog from "../actionLog";
import saveMatch from "../saveMatch";
import endDraft from "../endDraft";

interface Entry extends LogEntry {
  json: () => LogInfo;
}

export default function OutLogInfo(entry: Entry): void {
  const json = entry.json();
  if (!json) return;
  // console.log(json);

  if (json.params.messageName == "Client.UserDeviceSpecs") {
    const payload = {
      isWindowed: json.params.payloadObject.isWindowed,
      monitor: json.params.payloadObject.monitorResolution,
      game: json.params.payloadObject.gameResolution
    };
    ipcSend("set_device_specs", payload);
  }
  if (json.params.messageName == "DuelScene.GameStart") {
    const gameNumber = json.params.payloadObject.gameNumber;
    actionLog(-2, globals.logTime, `Game ${gameNumber} Start`);
  }

  // REVIEW
  if (json.params.messageName == "Client.Connected") {
    //logLanguage = json.params.payloadObject.settings.language.language;
  }
  //if (skipMatch) return;
  if (json.params.messageName == "DuelScene.GameStop") {
    globals.currentMatch.opponent.cards = globals.currentMatch.oppCardsUsed;

    const payload = json.params.payloadObject;

    const loserName = getNameBySeat(payload.winningTeamId == 1 ? 2 : 1);
    if (payload.winningReason == "ResultReason_Concede") {
      actionLog(-1, globals.logTime, `${loserName} Conceded`);
    }
    if (payload.winningReason == "ResultReason_Timeout") {
      actionLog(-1, globals.logTime, `${loserName} Timed out`);
    }

    const playerName = getNameBySeat(payload.winningTeamId);
    actionLog(-1, globals.logTime, `${playerName} Wins!`);

    const mid = payload.matchId + "-" + playerData.arenaId;
    const time = payload.secondsCount;
    if (mid == globals.currentMatch.matchId) {
      globals.gameNumberCompleted = payload.gameNumber;

      const game: MatchGameStats = {
        time: time,
        winner: payload.winningTeamId,
        win: payload.winningTeamId == globals.currentMatch.player.seat,
        shuffledOrder: [],
        // defaults
        handsDrawn: [],
        handLands: [],
        cardsCast: [],
        deckSize: 0,
        landsInDeck: 0,
        multiCardPositions: {},
        librarySize: 0,
        landsInLibrary: 0,
        libraryLands: [],
        sideboardChanges: {
          added: [],
          removed: []
        },
        deck: {},
      };

      for (let i = 0; i < globals.initialLibraryInstanceIds.length; i++) {
        let instance = globals.initialLibraryInstanceIds[i];
        while (
          (!globals.instanceToCardIdMap[instance] ||
            !db.card(globals.instanceToCardIdMap[instance])) &&
          globals.idChanges[instance]
        ) {
          instance = globals.idChanges[instance];
        }
        const cardId = globals.instanceToCardIdMap[instance];
        if (db.card(cardId) !== undefined) {
          game.shuffledOrder.push(cardId);
        } else {
          break;
        }
      }
      game.handsDrawn = payload.mulliganedHands.map(hand =>
        hand.map(card => card.grpId)
      );
      game.handsDrawn.push(
        game.shuffledOrder.slice(0, 7 - game.handsDrawn.length)
      );

      if (globals.gameNumberCompleted > 1) {
        const originalDeck = globals.currentMatch.player.originalDeck.clone();
        const newDeck = globals.currentMatch.player.deck.clone();

        const sideboardChanges: MatchGameStats["sideboardChanges"] = {
          added: [],
          removed: []
        };

        const mainDiff: { [key: string]: number } = {};
        newDeck
          .getMainboard()
          .get()
          .forEach(card => {
            mainDiff[card.id] = (mainDiff[card.id] || 0) + card.quantity;
          });
        originalDeck
          .getMainboard()
          .get()
          .forEach(card => {
            if (mainDiff[card.id]) {
              mainDiff[card.id] -= card.quantity;
            }
          });

        Object.keys(mainDiff).forEach((id: string) => {
          for (let i = 0; i < mainDiff[id]; i++) {
            sideboardChanges.added.push(id);
          }
          //console.log(mainDiff[id] + " - " + db.card(id).name);
        });

        const sideDiff: { [key: string]: number } = {};
        newDeck
          .getSideboard()
          .get()
          .forEach(card => {
            sideDiff[card.id] = (sideDiff[card.id] || 0) + card.quantity;
          });
        originalDeck
          .getSideboard()
          .get()
          .forEach(card => {
            if (sideDiff[card.id]) {
              sideDiff[card.id] -= card.quantity;
            }
          });

        Object.keys(sideDiff).forEach((id: string) => {
          for (let i = 0; i < sideDiff[id]; i++) {
            sideboardChanges.removed.push(id);
          }
          //console.log(sideDiff[id] + " - " + db.card(id).name);
        });

        /*
        globals.matchGameStats.forEach((stats, i) => {
          if (i !== 0) {
            let prevChanges = stats.sideboardChanges;
            prevChanges.added.forEach(
              id => (deckDiff[id] = (deckDiff[id] || 0) - 1)
            );
            prevChanges.removed.forEach(
              id => (deckDiff[id] = (deckDiff[id] || 0) + 1)
            );
          }
        });
        */

        game.sideboardChanges = sideboardChanges;
        game.deck = newDeck.clone().getSave();
      }

      game.handLands = game.handsDrawn.map(
        hand => hand.filter(card => db.card(card)?.type.includes("Land")).length
      );
      const handSize = 8 - game.handsDrawn.length;
      let deckSize = 0;
      let landsInDeck = 0;
      const multiCardPositions: MatchGameStats["multiCardPositions"] = {
        "2": {},
        "3": {},
        "4": {}
      };
      const cardCounts: { [key: string]: number } = {};
      globals.currentMatch.player.deck
        .getMainboard()
        .get()
        .forEach(card => {
          cardCounts[card.id] = card.quantity;
          deckSize += card.quantity;
          if (card.quantity >= 2 && card.quantity <= 4) {
            multiCardPositions[card.quantity][card.id] = [];
          }
          const cardObj = db.card(card.id);
          if (cardObj && cardObj.type.includes("Land")) {
            landsInDeck += card.quantity;
          }
        });
      const librarySize = deckSize - handSize;
      const landsInLibrary =
        landsInDeck - game.handLands[game.handLands.length - 1];
      let landsSoFar = 0;
      const libraryLands: number[] = [];
      game.shuffledOrder.forEach((cardId, i) => {
        const cardCount = cardCounts[cardId];
        if (cardCount >= 2 && cardCount <= 4) {
          multiCardPositions[cardCount][cardId].push(i + 1);
        }
        if (i >= handSize) {
          const card = db.card(cardId);
          if (card && card.type.includes("Land")) {
            landsSoFar++;
          }
          libraryLands.push(landsSoFar);
        }
      });

      game.cardsCast = _.cloneDeep(globals.currentMatch.cardsCast);
      globals.currentMatch.cardsCast = [];
      game.deckSize = deckSize;
      game.landsInDeck = landsInDeck;
      game.multiCardPositions = multiCardPositions;
      game.librarySize = librarySize;
      game.landsInLibrary = landsInLibrary;
      game.libraryLands = libraryLands;

      globals.matchGameStats[globals.gameNumberCompleted - 1] = game;
      globals.currentMatch.matchTime = globals.matchGameStats.reduce(
        (acc, cur) => acc + cur.time,
        0
      );

      saveMatch(mid, new Date().getTime());
    }
  }

  if (json.params.messageName === "Client.SceneChange") {
    const { toSceneName } = json.params.payloadObject;
    if (toSceneName === "Home") {
      if (globals.debugLog || !globals.firstPass)
        ipcSend("set_arena_state", ARENA_MODE_IDLE);
      globals.duringMatch = false;
      endDraft();
    }
  }
}
