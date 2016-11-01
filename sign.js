/**
 * @module sign
 */

'use strict'

const child = require('child_process')
const path = require('path')

const Promise = require('bluebird')

const compareVersion = require('compare-version')

const util = require('./util')
const debuglog = util.debuglog
const debugwarn = util.debugwarn
const debugerror = util.debugerror
const getAppContentsPath = util.getAppContentsPath
const execFileAsync = util.execFileAsync
const validateOptsAppAsync = util.validateOptsAppAsync
const validateOptsPlatformAsync = util.validateOptsPlatformAsync
const walkAsync = util.walkAsync
const findIdentitiesAsync = require('./util-identities').findIdentitiesAsync
const preEmbedProvisioningProfile = require('./util-provisioning-profiles').preEmbedProvisioningProfile
const preAutoEntitlements = require('./util-entitlements').preAutoEntitlements

/**
 * This function returns a promise validating opts.binaries, the additional binaries to be signed along with the discovered enclosed components.
 * @function
 * @param {Object} opts - Options.
 * @returns {Promise} Promise.
 */
function validateOptsBinariesAsync (opts) {
  return new Promise(function (resolve, reject) {
    if (opts.binaries) {
      if (!Array.isArray(opts.binaries)) {
        reject(new Error('Additional binaries should be an Array.'))
        return
      }
      // TODO: Loop check every binary file for existence, reject promise if any not found
    }
    resolve(undefined)
  })
}

/**
 * This function returns a promise validating all options passed in opts.
 * @function
 * @param {Object} opts - Options.
 * @returns {Promise} Promise.
 */
function validateSignOptsAsync (opts) {
  const ProvisioningProfile = require('./util-provisioning-profiles').ProvisioningProfile

  if (opts.ignore) {
    if (typeof opts.ignore !== 'function' && typeof opts.ignore !== 'string') return Promise.reject(new Error('Ignore filter should be either a function or a string.'))
  }

  if (opts['provisioning-profile']) {
    if (typeof opts['provisioning-profile'] !== 'string' || !(opts['provisioning-profile'] instanceof ProvisioningProfile)) return Promise.reject(new Error('Path to provisioning profile should be a string or a ProvisioningProfile object.'))
  }

  if (opts['type']) {
    if (opts['type'] !== 'development' && opts['type'] !== 'distribution') return Promise.reject(new Error('Type must be either `development` or `distribution`.'))
  } else {
    opts['type'] = 'distribution'
  }

  return Promise.map([
    validateOptsAppAsync,
    validateOptsPlatformAsync,
    validateOptsBinariesAsync
  ], function (validate) {
    return validate(opts)
  })
}

/**
 * This function returns a promise verifying the code sign of application bundle.
 * @function
 * @param {Object} opts - Options.
 * @returns {Promise} Promise resolving output.
 */
function verifySignApplicationAsync (opts) {
  // Verify with codesign
  var promise = new Promise(function (resolve, reject) {
    debuglog('Verifying application bundle with codesign...')
    child.execFile('codesign', [
      '--verify',
      '--deep',
      '--strict',
      '--verbose=2',
      opts.app
    ], function (err, stdout, stderr) {
      if (err) {
        debugerror(err)
        reject('Failed to verify application bundle. See details in debug log. (electron-osx-sign:error)')
        return
      }
      debuglog('Result:\n' + stderr)
      resolve(undefined)
    })
  })

  // Additionally test Gatekeeper acceptance for darwin platform
  if (opts.platform === 'darwin') {
    promise = promise.then(function () {
      return new Promise(function (resolve, reject) {
        debuglog('Verifying Gatekeeper acceptance for darwin platform...')
        child.execFile('spctl', [
          '--assess',
          '--type', 'execute',
          '--verbose',
          '--ignore-cache',
          '--no-cache',
          opts.app
        ], function (err, stdout, stderr) {
          if (err) {
            debugerror(err)
            reject('Failed to pass Gatekeeper. See details in debug log. (electron-osx-sign:error)')
            return
          }
          debuglog('Result:\n' + stderr)
          resolve(undefined)
        })
      })
    })
  }

  return promise
}

/**
 * This function returns a promise codesigning only.
 * @function
 * @param {Object} opts - Options.
 * @returns {Promise} Promise.
 */
function signApplicationAsync (opts) {
  return walkAsync(getAppContentsPath(opts))
    .then(function (childPaths) {
      function ignoreFilePath (opts, filePath) {
        if (opts.ignore) {
          if (typeof opts.ignore === 'function') {
            return opts.ignore(filePath)
          } else if (typeof opts.ignore === 'string') {
            return filePath.match(opts.ignore)
          }
        }
        return false
      }

      if (opts.binaries) childPaths = childPaths.concat(opts.binaries)

      var args = [
        '--sign', opts.identity,
        '--force'
      ]
      if (opts.keychain) {
        args.push('--keychain', opts.keychain)
      }
      if (opts.requirements) {
        args.push('--requirements', opts.requirements)
      }

      var promise
      if (opts.entitlements) {
        // Sign with entitlements
        promise = Promise.mapSeries(childPaths, function (filePath) {
          if (ignoreFilePath(opts, filePath)) {
            debuglog('Skipped... ' + filePath)
            return
          }
          debuglog('Signing... ' + filePath)
          return execFileAsync('codesign', args.concat('--entitlements', opts['entitlements-inherit'], filePath))
        })
          .then(function () {
            debuglog('Signing... ' + opts.app)
            return execFileAsync('codesign', args.concat('--entitlements', opts.entitlements, opts.app))
          })
      } else {
        // Otherwise normally
        promise = Promise.mapSeries(childPaths, function (filePath) {
          if (ignoreFilePath(opts, filePath)) {
            debuglog('Skipped... ' + filePath)
            return
          }
          debuglog('Signing... ' + filePath)
          return execFileAsync('codesign', args.concat(filePath))
        })
          .then(function () {
            debuglog('Signing... ' + opts.app)
            return execFileAsync('codesign', args.concat(opts.app))
          })
      }

      return promise
        .then(function () {
          // Verify code sign
          debuglog('Verifying...')
          var promise = verifySignApplicationAsync(opts)
            .then(function (result) {
              debuglog('Verified.')
            })
          // Check entitlements if applicable
          if (opts.entitlements) {
            promise = promise
              .then(function () {
                debuglog('Displaying entitlements...')
                return execFileAsync('codesign', [
                  '--display',
                  '--entitlements',
                  '-',
                  opts.app
                ])
              })
              .then(function (result) {
                debuglog('Entitlements (prefixed with blob header):\n' + result)
              })
          }
          return promise
        })
    })
    .thenReturn(undefined)
}

/**
 * This function returns a promise signing the application.
 * @function
 * @param {mixed} opts - Options.
 * @returns {Promise} Promise.
 */
var signAsync = module.exports.signAsync = function (opts) {
  return validateSignOptsAsync(opts)
    .then(function () {
      // Determine identity for signing
      var promise
      if (opts.identity) {
        debuglog('`identity` passed in arguments.')
        promise = findIdentitiesAsync(opts, opts.identity)
      } else {
        debugwarn('No `identity` passed in arguments...')
        if (opts.platform === 'mas') {
          if (opts.type === 'distribution') {
            debuglog('Finding `3rd Party Mac Developer Application` certificate for signing app distribution in the Mac App Store...')
            promise = findIdentitiesAsync(opts, '3rd Party Mac Developer Application:')
          } else {
            debuglog('Finding `Mac Developer` certificate for signing app in development for the Mac App Store signing...')
            promise = findIdentitiesAsync(opts, 'Mac Developer:')
          }
        } else {
          debuglog('Finding `Developer ID Application` certificate for distribution outside the Mac App Store...')
          promise = findIdentitiesAsync(opts, 'Developer ID Application:')
        }
      }
      return promise
        .then(function (identities) {
          if (identities.length > 0) {
            // Provisioning profile(s) found
            if (identities.length > 1) {
              debugwarn('Multiple identities found, will use the first discovered.')
            } else {
              debuglog('Found 1 identity.')
            }
            opts.identity = identities[0]
          } else {
            // No identity found
            return Promise.reject(new Error('No identity found for signing.'))
          }
        })
    })
    .then(function () {
      // Determine entitlements for code signing
      var filePath
      if (opts.platform === 'mas') {
        // To sign apps for Mac App Store, an entitlements file is required, especially for app sandboxing (as well some other services).
        // Fallback entitlements for sandboxing by default: Note this may cause troubles while running an signed app due to missing keys special to the project.
        // Further reading: https://developer.apple.com/library/mac/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html
        if (!opts.entitlements) {
          filePath = path.join(__dirname, 'default.entitlements.mas.plist')
          debugwarn('No `entitlements` passed in arguments:', '\n',
            '* Sandbox entitlements are required for Mac App Store distribution, your codesign entitlements file is default to:', filePath)
          opts.entitlements = filePath
        }
        if (!opts['entitlements-inherit']) {
          filePath = path.join(__dirname, 'default.entitlements.mas.inherit.plist')
          debugwarn('No `entitlements-inherit` passed in arguments:', '\n',
            '* Sandbox entitlements file for enclosing app files is default to:', filePath)
          opts['entitlements-inherit'] = filePath
        }
      } else {
        // Not necessary to have entitlements for non Mac App Store distribution
        if (!opts.entitlements) {
          debugwarn('No `entitlements` passed in arguments:', '\n',
            '* Provide `entitlements` to specify entitlements file for codesign.')
        } else {
          // If entitlements is provided as a flag, fallback to default
          if (opts.entitlements === true) {
            filePath = path.join(__dirname, 'default.entitlements.darwin.plist')
            debugwarn('`entitlements` not specified in arguments:', '\n',
              '* Provide `entitlements` to specify entitlements file for codesign.', '\n',
              '* Sandbox entitlements file for enclosing app files is default to:', filePath)
            opts.entitlements = filePath
          }
          if (!opts['entitlements-inherit']) {
            filePath = path.join(__dirname, 'default.entitlements.darwin.inherit.plist')
            debugwarn('No `entitlements-inherit` passed in arguments:', '\n',
              '* Sandbox entitlements file for enclosing app files is default to:', filePath)
            opts['entitlements-inherit'] = filePath
          }
        }
      }
    })
    .then(function () {
      // Pre-sign operations
      var preSignOperations = []

      if (opts['pre-embed-provisioning-profile'] === false) {
        debugwarn('Pre-sign operation disabled for provisioning profile embedding:', '\n',
          '* Enable by setting `pre-embed-provisioning-profile` to `true`.')
      } else {
        debuglog('Pre-sign operation enabled for provisioning profile:', '\n',
          '* Disable by setting `pre-embed-previsioning-profile` to `false`.')
        preSignOperations.push(preEmbedProvisioningProfile)
      }

      if (opts['pre-auto-entitlements'] === false) {
        debugwarn('Pre-sign operation disabled for entitlements automation.')
      } else {
        debuglog('Pre-sign operation enabled for entitlements automation with versions >= `1.1.1`:', '\n',
          '* Disable by setting `pre-auto-entitlements` to `false`.')
        if (opts.entitlements && (!opts.version || compareVersion(opts.version, '1.1.1') >= 0)) {
          // Enable Mac App Store sandboxing without using temporary-exception, introduced in Electron v1.1.1. Relates to electron#5601
          preSignOperations.push(preAutoEntitlements)
        }
      }

      return Promise.mapSeries(preSignOperations, function (preSignOperation) {
        return preSignOperation(opts)
      })
    })
    .then(function () {
      debuglog('Signing application...', '\n',
        '> Application:', opts.app, '\n',
        '> Platform:', opts.platform, '\n',
        '> Entitlements:', opts.entitlements, '\n',
        '> Child entitlements:', opts['entitlements-inherit'], '\n',
        '> Additional binaries:', opts.binaries, '\n',
        '> Identity:', opts.identity)
      return signApplicationAsync(opts)
    })
    .then(function () {
      // Post-sign operations
      debuglog('Application signed.')
    })
}

/**
 * This function is a normal callback implementation.
 * @function
 * @param {Object} opts - Options.
 * @param {RequestCallback} cb - Callback.
 */
module.exports.sign = function (opts, cb) {
  // Default callback function if none provided
  if (!cb) {
    cb = function (err) {
      if (err) {
        debugerror('Sign failed:')
        if (err.message) debugerror(err.message)
        else if (err.stack) debugerror(err.stack)
        else debugerror(err)
        return
      }
      debuglog('Application signed: ' + opts.app)
    }
  }

  signAsync(opts)
    .then(cb)
    .catch(cb)
}
