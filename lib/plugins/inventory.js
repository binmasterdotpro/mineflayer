const assert = require('assert')
const {Vec3} = require('vec3')
const {once} = require('events')
const {sleep, createDoneTask, createTask, withTimeout} = require('../promise_utils')

module.exports = inject

function inject(bot) {
    const Item = require('prismarine-item')(bot.registry)
    const windows = require('prismarine-windows')(bot.version)

    let eatingTask = createDoneTask()

    let nextActionNumber = 0 // < 1.17
    let stateId = -1
    if (bot.supportFeature('stateIdUsed')) {
        const listener = packet => {
            stateId = packet.stateId
        }
        bot._client.on('window_items', listener)
        bot._client.on('set_slot', listener)
    }

    // 0-8, null = uninitialized
    // which quick bar slot is selected
    bot.quickBarSlot = null
    // needed for physics to work
    bot.inventory = {}
    bot.inventory.slots = []
    bot.inventory.items = () => {
        return []
    }

    function confirmTransaction(windowId, actionId, accepted) {
        bot._client.write('transaction', {
            windowId,
            action: actionId,
            accepted: true
        })
    }

    bot._client.on('transaction', (packet) => {
        // confirm transaction
        confirmTransaction(packet.windowId, packet.action, packet.accepted)
    })

    bot._client.on('held_item_slot', (packet) => {
        // held item change
        bot.setQuickBarSlot(packet.slot)
    })
}
