const assert = require('assert')

module.exports = inject

const QUICK_BAR_START = 36

function inject (bot) {
  function setQuickBarSlot (slot) {
    assert.ok(slot >= 0)
    assert.ok(slot < 9)
    if (bot.quickBarSlot === slot) return
    bot.quickBarSlot = slot
    bot._client.write('held_item_slot', {
      slotId: slot
    })
  }

  bot.setQuickBarSlot = setQuickBarSlot

  // constants
  bot.QUICK_BAR_START = QUICK_BAR_START
}
