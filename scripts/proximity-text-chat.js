import { libWrapper } from "../lib/shim.js";

const moduleID = "proximity-text-chat";

Hooks.once("init", () => {
    // Enable proximity chatting
    game.settings.register(moduleID, "proximityEnabled", {
        name: `${moduleID}.settings.proximityEnabled.name`,
        hint: "",
        scope: "world",
        config: true,
        type: Boolean,
        default: true
    });

    // Set grid distance that is considered "within proximity"
    game.settings.register(moduleID, "proximityDistance", {
        name: `${moduleID}.settings.proximityDistance.name`,
        hint: `${moduleID}.settings.proximityDistance.hint`,
        scope: "world",
        config: true,
        type: Number,
        default: 30,
        range: {
            min: 5,
            max: 200,
            step: 5
        }
    });

    // Set grid distance for tokens that can hear /scream commands
    game.settings.register(moduleID, "screamDistance", {
        name: `${moduleID}.settings.screamDistance.name`,
        hint: `${moduleID}.settings.screamDistance.hint`,
        scope: "world",
        config: true,
        type: Number,
        default: 60,
        range: {
            min: 5,
            max: 200,
            step: 5
        }
    });

    // Enable hiding of roll-type messages
    game.settings.register(moduleID, "hideRolls", {
        name: `${moduleID}.settings.hideRolls.name`,
        hint: "",
        scope: "world",
        config: true,
        type: Boolean,
        default: true
    });

    game.settings.register(moduleID, "hideBySight", {
        name: `${moduleID}.settings.hideBySight.name`,
        hint: "",
        scope: "world",
        config: true,
        type: Boolean,
        default: false
    });

    // Set up module socket
    game.socket.on(`module.${moduleID}`, data => {
        const { action } = data;

        if (action === "showMessage") {
            if (game.user.id !== game.users.find(u => u.active && u.isGM).id) return; 
            const { messageID, userID } = data;
            if (game.users.get(userID).isGM) return;

            const message = game.messages.get(messageID);
            const hearMap = message.getFlag(moduleID, "users");
            if (!hearMap) return;
            hearMap[userID] = true;
            message.setFlag(moduleID, "users", hearMap);
        }

        if (action === "hideBySight") {
            if (game.user.id !== game.users.find(u => u.active && u.isGM).id) return;

            const { messageID, userID } = data;
            if (game.users.get(userID).isGM) return;
            const message = game.messages.get(messageID);
            const hearMap = message.getFlag(moduleID, "users");
            hearMap[userID] = false;
            message.setFlag(moduleID, "users", hearMap);
        }
    });

    libWrapper.register(moduleID, "ChatMessage.prototype.visible", function(wrapped) {
        const vis = wrapped();
        //if (!vis) return false;
        if (game.user.isGM) return true;

        const hearMap = this.getFlag(moduleID, "users");
        if (!hearMap) return vis;
        return hearMap[game.user.id];
    }, "WRAPPER");
});


Hooks.on("preCreateChatMessage", (message, data, options, userID) => {
    const oocTabActive = $(document).find(`nav.tabbedchatlog.tabs`).find(`a.item.ooc`).hasClass("active");
    if (message.type === 1 || oocTabActive) return;

    const speaker = [0,4,5].includes(message.type) ? canvas.tokens.controlled[0] : canvas.tokens.get(message.speaker.token);
    if (!speaker) return;

    if (!game.settings.get(moduleID, "hideRolls") && (message.type === 0 || message.type === 5)) return;

    // Initiate hearMap in message flag
    const hearMap = {};
    game.users.forEach(u => {
        if (u.isGM) return;
        hearMap[u.id] = false;
    });
    hearMap[game.user.id] = true;``
    const update = {
        [`flags.${moduleID}`]: {
            "users": hearMap
        }
    };
    //if (message.type === 4) update[`flags.${moduleName}`].speaker = speaker.id;
    if ([0,4,5].includes(message.type)) update[`flags.${moduleID}`].speaker = speaker.id;
    message.updateSource(update);

    // Prevent automatic chat bubble creation; will be handled manually in createChatMessge hook
    options.chatBubble = false;
    return;
});

Hooks.on("createChatMessage", (message, options, userID) => {
    const listener = canvas.tokens.controlled[0] || game.user.character?.getActiveTokens()[0];
    if (!listener) return;
    
    const speakerID = message.type === 4 ? message.getFlag(moduleID, "speaker") : message.speaker.token;
    const speaker = canvas.tokens.get(speakerID);
    if (!speaker) return;

    const d = canvas.grid.measureDistance(speaker, listener, { gridSpaces: true });
    const isScream = message.getFlag(moduleID, "isScream");
    let distanceCanHear = isScream ? game.settings.get(moduleID, "screamDistance") : game.settings.get(moduleID, "proximityDistance");
    const improvedHearingDistance = listener.document.getFlag(moduleID, "improvedHearingDistance");
    distanceCanHear += improvedHearingDistance || 0;
    let messageText = "......";
    const telepathyTarget = message.getFlag(moduleID, "telepathyTarget");
    let processHideBySight = true;
    if (game.settings.get(moduleID, "hideBySight") && !speaker.isVisible) processHideBySight = false;
    if (
        (d <= distanceCanHear || telepathyTarget === game.user.id) 
        && processHideBySight
    ) {
        // Set current user to true in hearMap
        game.socket.emit(`module.${moduleID}`, {
            action: "showMessage",
            messageID: message.id,
            userID: game.user.id
        });

        // Use true message text for chat bubble
        messageText = message.content;

    }

    // Manually create chat bubble
    if (message.type === 2) canvas.hud.bubbles.say(speaker, messageText);
});

// Register Chat Commands
Hooks.on("chatCommandsReady", chatCommands => {
    const screamCommand = chatCommands.createCommandFromData({
        commandKey: "/scream",
        invokeOnCommand: (chatLog, messageText, chatData) => {
            Hooks.once("preCreateChatMessage", (message, data, options, userID) => {
                // Flag chat message as a scream
                message.update({
                    [`flags.${moduleID}`]: {
                        isScream: true
                    },
                    type: 2,
                });
            });
            return messageText;
        },
        shouldDisplayToChat: true,
        description: game.i18n.localize(`${moduleID}.screamDesc`)
    });
    chatCommands.registerCommand(screamCommand);

    const telepathyCommand = chatCommands.createCommandFromData({
        commandKey: "/telepathy",
        invokeOnCommand: (chatLog, messageText, chatData) => {
            const target = messageText.split(" ")[0];
            const user = game.users.getName(target);
            if (user) {
                Hooks.once("preCreateChatMessage", (message, data, options, userID) => {
                    // Flag chat message as telepathy and udpate message to a whisper
                    message.update({
                        [`flags.${moduleID}`]: {
                            telepathyTarget: user.id,
                            speaker: canvas.tokens.controlled[0].id
                        },
                        type: 2,
                        whisper: [user.id],
                        speaker: {
                            token: canvas.tokens.controlled[0].id
                        }
                    });
                });
            }

            return messageText.replace(target, "");
        },
        shouldDisplayToChat: true,
        description: game.i18n.localize(`${moduleID}.telepathyDesc`)
    });
    chatCommands.registerCommand(telepathyCommand);
});

// Implement improvedHearingDistance flag on tokens
Hooks.on("renderTokenConfig", (app, html, appData) => {
    html.find(`div.tab[data-tab="character"]`).append(`
        <div class="form-group slim">
            <label>
            ${game.i18n.localize(`${moduleID}.improvedHearingDistance`)}
            <span class="units">(${game.i18n.localize(`${moduleID}.gridUnits`)})</span>
            </label>
            <div class="form-fields">
                <input type="number" name="flags.${moduleID}.improvedHearingDistance" placeholder="0" value="${appData.object.flags[moduleID]?.improvedHearingDistance}" />
            </div>
        </div>
    `);
    html.css("height", "auto");
});
