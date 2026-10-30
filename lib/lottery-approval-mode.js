'use strict';

const MANUAL = 'manual';
const AUTOMATIC = 'automatic';

function approvalModeFor(lottery) {
  return lottery && lottery.approvalMode === AUTOMATIC ? AUTOMATIC : MANUAL;
}

function usesAutomaticApproval(lottery) {
  return approvalModeFor(lottery) === AUTOMATIC;
}

module.exports = { MANUAL, AUTOMATIC, approvalModeFor, usesAutomaticApproval };
