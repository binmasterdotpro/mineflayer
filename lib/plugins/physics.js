const {Vec3} = require('vec3')
const assert = require('assert')
const math = require('../math')
const conv = require('../conversions')
const {performance} = require('perf_hooks')
const {createDoneTask, createTask} = require('../promise_utils')

const {Physics, PlayerState} = require('prismarine-physics')

// optional: toggling f32 for less precision but more java-like behavior (still not very accurate)
// const f32 = Math.fround
const f32 = (x) => x

// default is 0.5F
const rawSensitivity = f32(0.5)
// https://github.com/Marcelektro/MCP-919/blob/1717f75902c6184a1ed1bfcd7880404aab4da503/src/minecraft/net/minecraft/client/renderer/EntityRenderer.java#L1097
const f = rawSensitivity * f32(0.6) + f32(0.2)
const calculatedSensitivity = f * f * f * f32(8.0)
// 0.15D
// https://github.com/Marcelektro/MCP-919/blob/1717f75902c6184a1ed1bfcd7880404aab4da503/src/minecraft/net/minecraft/entity/Entity.java#L389
const sensitivityConstant = 0.15 * calculatedSensitivity

module.exports = inject

const PHYSICS_INTERVAL_MS = 50
const PHYSICS_TIMESTEP = PHYSICS_INTERVAL_MS / 1000 // 0.05

function checkInputEquality(oldInput, newInput) {
    const oldKeys = Object.keys(oldInput)
    const newKeys = Object.keys(newInput)
    if (oldKeys.length !== newKeys.length) return false
    for (const key of oldKeys) {
        if (oldInput[key] !== newInput[key]) return false
    }
    return true
}

function cloneInput(input) {
    return {
        forward: input.forward,
        back: input.back,
        left: input.left,
        right: input.right,
        jump: input.jump,
        sprint: input.sprint,
        sneak: input.sneak
    }
}

function inject(bot, {physicsEnabled, maxCatchupTicks}) {
    const POSITION_EVERY_N_TICKS = (bot.version === "1.21.5" ? 19 : 20)
    const PHYSICS_CATCHUP_TICKS = maxCatchupTicks ?? 4
    const world = {
        getBlock: (pos) => {
            return bot.blockAt(pos, false)
        }
    }
    const physics = Physics(bot.registry, world)
    const positionUpdateSentEveryTick = bot.supportFeature('positionUpdateSentEveryTick')

    // actual internal yaw and pitch are stored in notchian format so that we don't lose precision

    bot.jumpQueued = false
    bot.jumpTicks = 0 // autojump cooldown

    const controlState = {
        forward: false,
        back: false,
        left: false,
        right: false,
        jump: false,
        sprint: false,
        sneak: false
    }

    let doPhysicsTimer = null
    let lastPhysicsFrameTime = null
    let shouldUsePhysics = false
    bot.physicsEnabled = physicsEnabled ?? true
    let deadTicks = 21

    let lastSent = {
        x: 0,
        y: 0,
        z: 0,
        // notchian
        yaw: 0,
        pitch: 0,
        onGround: false,
        ticker: 20,
        flags: {onGround: false, hasHorizontalCollision: false},
        // keep track of serverside sneak and sprint
        sprintState: false,
        sneakState: false,
        previousInputState: cloneInput(controlState)
    }

    // expose lastSent to outside plugins
    bot._lastSent = lastSent

    // This function should be executed each tick (every 0.05 seconds)
    // How it works: https://gafferongames.com/post/fix_your_timestep/

    // WARNING: THIS IS NOT ACCURATE ON WINDOWS (15.6 Timer Resolution)
    // use WSL or switch to Linux
    // see: https://discord.com/channels/413438066984747026/519952494768685086/901948718255833158
    let timeAccumulator = 0
    let catchupTicks = 0

    function doPhysics() {
        const now = performance.now()
        const deltaSeconds = (now - lastPhysicsFrameTime) / 1000
        lastPhysicsFrameTime = now

        timeAccumulator += deltaSeconds
        catchupTicks = 0
        while (timeAccumulator >= PHYSICS_TIMESTEP) {
            tickPhysics(now)
            timeAccumulator -= PHYSICS_TIMESTEP
            catchupTicks++
            if (catchupTicks >= PHYSICS_CATCHUP_TICKS) break
        }
    }

    function tickPhysics(now) {
        if (bot.blockAt(bot.entity.position) == null) return // check if chunk is unloaded
        bot.emit('physicsTickBegin')
        if (bot.physicsEnabled && shouldUsePhysics) {
            if (typeof bot.entity.yawDegrees !== 'number') {
                bot.entity.yawDegrees = 0
                bot.entity.pitchDegrees = 0
            }
            physics.simulatePlayer(new PlayerState(bot, controlState, lastSent), world).apply(bot)
            updatePosition(now)
            bot.emit('physicsTick')
        }
        if (bot.version === "1.21.5") {
            bot._client.write("tick_end")
        }
    }

    function cleanup() {
        clearInterval(doPhysicsTimer)
        doPhysicsTimer = null
    }

    function sendPacketPosition(position, onGround) {
        // sends data, no logic
        const oldPos = new Vec3(lastSent.x, lastSent.y, lastSent.z)
        lastSent.x = position.x
        lastSent.y = position.y
        lastSent.z = position.z
        lastSent.onGround = onGround
        lastSent.flags = {onGround, hasHorizontalCollision: undefined} // 1.21.3+
        bot._client.write('position', lastSent)
        bot.emit('move', oldPos)
    }

    function sendPacketLook(yaw, pitch, onGround) {
        // sends data, no logic
        const oldPos = new Vec3(lastSent.x, lastSent.y, lastSent.z)
        lastSent.yaw = yaw
        lastSent.pitch = pitch
        lastSent.onGround = onGround
        lastSent.flags = {onGround, hasHorizontalCollision: undefined} // 1.21.3+
        bot._client.write('look', lastSent)
        bot.emit('move', oldPos)
    }

    function sendPacketPositionAndLook(position, yaw, pitch, onGround) {
        // sends data, no logic
        const oldPos = new Vec3(lastSent.x, lastSent.y, lastSent.z)
        lastSent.x = position.x
        lastSent.y = position.y
        lastSent.z = position.z
        lastSent.yaw = yaw
        lastSent.pitch = pitch
        lastSent.onGround = onGround
        lastSent.flags = {onGround, hasHorizontalCollision: undefined} // 1.21.3+
        bot._client.write('position_look', lastSent)
        bot.emit('move', oldPos)
    }

    function deltaYawDegrees(yaw1, yaw2) {
        let dYaw = (yaw1 - yaw2) % 360
        if (dYaw < -180) dYaw += 360
        else if (dYaw > 180) dYaw -= 360

        return dYaw
    }

    // returns false if bot should send position packets
    function isEntityRemoved() {
        if (bot.isAlive === true) deadTicks = 0
        if (bot.isAlive === false && deadTicks <= 20) deadTicks++
        if (deadTicks >= 20) return true
        return false
    }

    function updatePosition() {
        // Only send updates for 20 ticks after death
        if (isEntityRemoved()) return

        const forward = (controlState.forward ? 1 : 0) - (controlState.back ? 1 : 0)
        const isSprintingApplicable = forward > 0 && !controlState.sneak
        // treat controlState.sprint as a request (sprint held), not necessary to fulfill it
        const actualSprint = isSprintingApplicable && controlState.sprint

        if (lastSent.sprintState !== actualSprint) {
            bot._client.write('entity_action', {
                entityId: bot.entity.id,
                actionId: actualSprint ? 3 : 4,
                jumpBoost: 0,
            });
            lastSent.sprintState = actualSprint;
        }

        if (lastSent.sneakState !== controlState.sneak) {
            bot._client.write('entity_action', {
                entityId: bot.entity.id,
                actionId: controlState.sneak ? 0 : 1,
                jumpBoost: 0,
            });
            lastSent.sneakState = controlState.sneak;
        }

        if (bot.version === "1.21.5" && !checkInputEquality(lastSent.previousInputState, controlState)) {
            lastSent.previousInputState = cloneInput(controlState)
            bot._client.write("player_input", {
                inputs: {
                    forward: controlState.forward,
                    backward: controlState.back,
                    left: controlState.left,
                    right: controlState.right,
                    jump: controlState.jump,
                    shift: controlState.sneak,
                    sprint: controlState.sprint
                }
            })
        }

        const yaw = lastSent.yaw + deltaYawDegrees(bot.entity.yawDegrees, lastSent.yaw)
        const pitch = bot.entity.pitchDegrees

        const position = bot.entity.position
        const onGround = bot.entity.onGround

        // Only send a position update if necessary, select the appropriate packet
        const positionUpdated = lastSent.x !== position.x || lastSent.y !== position.y || lastSent.z !== position.z ||
            // Send a position update every second, even if no other update was made
            // This function rounds to the nearest 50ms (or PHYSICS_INTERVAL_MS) and checks if a second has passed.
            // should be
            lastSent.ticker === 0
        const lookUpdated = lastSent.yaw !== yaw || lastSent.pitch !== pitch
        if (positionUpdated && lookUpdated) {
            sendPacketPositionAndLook(position, yaw, pitch, onGround)
            lastSent.ticker = POSITION_EVERY_N_TICKS // only reset if positionUpdated is true
        } else if (positionUpdated) {
            sendPacketPosition(position, onGround)
            lastSent.ticker = POSITION_EVERY_N_TICKS // only reset if positionUpdated is true
        } else if (lookUpdated) {
            sendPacketLook(yaw, pitch, onGround)
        } else if (positionUpdateSentEveryTick || onGround !== lastSent.onGround) {
            // For versions < 1.12, one player packet should be sent every tick
            // for the server to update health correctly
            // For versions >= 1.12, onGround !== lastSent.onGround should be used, but it doesn't ever trigger outside of login
            bot._client.write('flying', {
                onGround: bot.entity.onGround,
                flags: {onGround: bot.entity.onGround, hasHorizontalCollision: undefined} // 1.21.3+
            })
        }

        if (!positionUpdated) {
            lastSent.ticker -= 1
        }

        lastSent.onGround = bot.entity.onGround // onGround is always set
    }

    bot.physics = physics

    function getEffectLevel(mcData, effectName, effects) {
        const effectDescriptor = mcData.effectsByName[effectName]
        if (!effectDescriptor) {
            return 0
        }
        const effectInfo = effects[effectDescriptor.id]
        if (!effectInfo) {
            return 0
        }
        return effectInfo.amplifier + 1
    }

    bot.elytraFly = async () => {
        if (bot.entity.elytraFlying) {
            throw new Error('Already elytra flying')
        } else if (bot.entity.onGround) {
            throw new Error('Unable to fly from ground')
        } else if (bot.entity.isInWater) {
            throw new Error('Unable to elytra fly while in water')
        }

        const mcData = require('minecraft-data')(bot.version)
        if (getEffectLevel(mcData, 'Levitation', bot.entity.effects) > 0) {
            throw new Error('Unable to elytra fly with levitation effect')
        }

        const torsoSlot = bot.getEquipmentDestSlot('torso')
        const item = bot.inventory.slots[torsoSlot]
        if (item == null || item.name !== 'elytra') {
            throw new Error('Elytra must be equip to start flying')
        }
        bot._client.write('entity_action', {
            entityId: bot.entity.id,
            actionId: 8,
            jumpBoost: 0
        })
    }

    bot.spoofControlState = (control, state) => {
        controlState[control] = state
    }

    bot.setControlState = (control, state) => {
        assert.ok(control in controlState, `invalid control: ${control}`)
        assert.ok(typeof state === 'boolean', `invalid state: ${state}`)
        if (controlState[control] === state) return
        controlState[control] = state
        if (control === 'jump' && state) {
            bot.jumpQueued = true
        }
    }

    bot.getControlState = (control) => {
        assert.ok(control in controlState, `invalid control: ${control}`)
        return controlState[control]
    }

    bot.clearControlStates = () => {
        for (const control in controlState) {
            bot.setControlState(control, false)
        }
    }

    bot.controlState = {}

    for (const control of Object.keys(controlState)) {
        Object.defineProperty(bot.controlState, control, {
            get() {
                return controlState[control]
            },
            set(state) {
                bot.setControlState(control, state)
                return state
            }
        })
    }

    let lookingTask = createDoneTask()
    let targetYaw = null
    let targetPitch = null

    // https://github.com/Marcelektro/MCP-919/blob/1717f75902c6184a1ed1bfcd7880404aab4da503/src/minecraft/net/minecraft/entity/Entity.java#L389
    function setAngleDegrees(newYaw, newPitch, autoround = true) {
        const initialYaw = bot.entity.yawDegrees
        const initialPitch = bot.entity.pitchDegrees

        if (autoround) {
            bot.entity.yawDegrees = f32(bot.entity.yawDegrees + f32(Math.round((newYaw - initialYaw) / sensitivityConstant) * sensitivityConstant))
            bot.entity.pitchDegrees = f32(bot.entity.pitchDegrees + f32(Math.round((newPitch - initialPitch) / sensitivityConstant) * sensitivityConstant))
        } else {
            bot.entity.yawDegrees = f32(newYaw)
            bot.entity.pitchDegrees = f32(newPitch)
        }

        bot.entity.pitchDegrees = math.clamp(f32(-90.0), bot.entity.pitchDegrees, f32(90.0))

        bot.entity.yaw = conv.fromNotchianYaw(bot.entity.yawDegrees)
        bot.entity.pitch = conv.fromNotchianPitch(bot.entity.pitchDegrees)
    }

    bot.on('physicsTick', () => {
        if (!lookingTask.done) {
            if (Math.abs(deltaYawDegrees(bot.entity.yawDegrees, targetYaw)) < 0.1 && Math.abs(bot.entity.pitchDegrees - targetPitch) < 0.1) {
                lookingTask.finish()
            } else {
                // look toward it
                const yawChange = math.clamp(-physics.yawSpeed, deltaYawDegrees(targetYaw, bot.entity.yawDegrees), physics.yawSpeed)
                const pitchChange = math.clamp(-physics.pitchSpeed, targetPitch - bot.entity.pitchDegrees, physics.pitchSpeed)
                setAngleDegrees(bot.entity.yawDegrees + yawChange, bot.entity.pitchDegrees + pitchChange)
            }
        }
    })

    bot._client.on('explosion', explosion => {
        // TODO: emit an explosion event with more info
        if (bot.physicsEnabled && bot.game.gameMode !== 'creative') {
            if (explosion.playerKnockback) { // 1.21.3+
                // Fixes issue #3635
                bot.entity.velocity.x += explosion.playerKnockback.x
                bot.entity.velocity.y += explosion.playerKnockback.y
                bot.entity.velocity.z += explosion.playerKnockback.z
            }
            if ('playerMotionX' in explosion) {
                bot.entity.velocity.x += explosion.playerMotionX
                bot.entity.velocity.y += explosion.playerMotionY
                bot.entity.velocity.z += explosion.playerMotionZ
            }
        }
    })

    bot.look = async (yaw, pitch, force) => {
        if (!lookingTask.done) {
            lookingTask.finish() // finish the previous one
            targetYaw = null
            targetPitch = null
        }

        const yawNotchian = conv.toNotchianYaw(yaw)
        const pitchNotchian = conv.toNotchianPitch(pitch)

        if (force) {
            setAngleDegrees(yawNotchian, pitchNotchian)
            return
        }

        lookingTask = createTask()
        targetYaw = yawNotchian
        targetPitch = pitchNotchian
        return await lookingTask.promise
    }

    bot.lookAt = async (point, force) => {
        const delta = point.minus(bot.entity.position.offset(0, bot.entity.eyeHeight, 0))
        const yaw = Math.atan2(-delta.x, -delta.z)
        const groundDistance = Math.sqrt(delta.x * delta.x + delta.z * delta.z)
        const pitch = Math.atan2(delta.y, groundDistance)
        await bot.look(yaw, pitch, force)
    }

    // 1.21.3+
    bot._client.on('player_rotation', (packet) => {
        setAngleDegrees(packet.yaw, packet.pitch)
    })

    // player position and look (clientbound)
    // https://github.com/Marcelektro/MCP-919/blob/1717f75902c6184a1ed1bfcd7880404aab4da503/src/minecraft/net/minecraft/client/network/NetHandlerPlayClient.java#L669
    bot._client.on('position', (packet) => {
        // Is this necessary? Feels like it might wrongly overwrite hitbox size sometimes
        // e.g. when crouching/crawling/swimming. Can someone confirm?
        const {velocity, position} = bot.entity

        const bitflags = typeof packet.flags === 'object'

        // flags just indicate whether it is relative or absolute
        const flagX = bitflags ? packet.flags.x : (packet.flags & 1) !== 0
        const flagY = bitflags ? packet.flags.y : (packet.flags & 2) !== 0
        const flagZ = bitflags ? packet.flags.z : (packet.flags & 4) !== 0
        const flagYaw = bitflags ? packet.flags.yaw : (packet.flags & 8) !== 0
        const flagPitch = bitflags ? packet.flags.pitch : (packet.flags & 16) !== 0

        // these are double resolution
        const newX = (flagX ? position.x : 0) + packet.x
        const newY = (flagY ? position.y : 0) + packet.y
        const newZ = (flagZ ? position.z : 0) + packet.z

        if (typeof bot.entity.yawDegrees !== 'number') {
            bot.entity.yawDegrees = 0
            bot.entity.pitchDegrees = 0
        }

        // these are float resolution
        const newYaw = (flagYaw ? bot.entity.yawDegrees : 0) + packet.yaw
        const newPitch = (flagPitch ? bot.entity.pitchDegrees : 0) + packet.pitch

        velocity.set(
            flagX ? velocity.x : 0,
            flagY ? velocity.y : 0,
            flagZ ? velocity.z : 0
        )

        position.set(newX, newY, newZ)

        setAngleDegrees(newYaw, newPitch)

        if (bot.supportFeature('teleportUsesOwnPacket')) {
            bot._client.write('teleport_confirm', {teleportId: packet.teleportId})
        }

        // onground is always false for response, but not set in theory
        sendPacketPositionAndLook(position, newYaw, newPitch, false)

        shouldUsePhysics = true
        bot.jumpTicks = 0

        bot.emit('forcedMove')
    })

    bot.waitForTicks = async function (ticks) {
        if (ticks <= 0) return
        await new Promise(resolve => {
            const tickListener = () => {
                ticks--
                if (ticks === 0) {
                    bot.removeListener('physicsTick', tickListener)
                    resolve()
                }
            }

            bot.on('physicsTick', tickListener)
        })
    }

    bot.on('mount', () => {
        shouldUsePhysics = false
    })

    function forceResetControls() {
        for (const control in controlState) {
            controlState[control] = false
        }
    }

    bot.on('respawn', () => {
        bot.entity.yawDegrees = 0
        bot.entity.pitchDegrees = 0
        shouldUsePhysics = false
        forceResetControls()
    })

    bot.on('login', () => {
        bot.entity.yawDegrees = 0
        bot.entity.pitchDegrees = 0
        shouldUsePhysics = false
        forceResetControls()
        lastSent = {
            x: 0,
            y: 0,
            z: 0,
            // notchian
            yaw: 0,
            pitch: 0,
            onGround: false,
            ticker: 20,
            flags: {onGround: false, hasHorizontalCollision: false},
            // keep track of serverside sneak and sprint
            sprintState: false,
            sneakState: false,
            previousInputState: cloneInput(controlState)
        }
        bot._lastSent = lastSent

        if (doPhysicsTimer === null) {
            lastPhysicsFrameTime = performance.now()
            doPhysicsTimer = setInterval(doPhysics, PHYSICS_INTERVAL_MS)
        }
    })
    bot.on('end', cleanup)
}
