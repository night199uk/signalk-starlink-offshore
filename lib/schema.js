'use strict'

const schema = {
  title: 'Starlink Offshore',
  type: 'object',
  properties: {
    lookaheadNm: {
      type: 'number',
      title: 'Distance horizon (nautical miles) for the crossing forecast',
      default: 250,
      minimum: 10
    },
    warningDistanceNm: {
      type: 'number',
      title: 'Distance (nautical miles) at which an upcoming crossing raises a notification',
      default: 2,
      minimum: 0
    },
    computeIntervalSeconds: {
      type: 'number',
      title: 'Recalculate every N seconds',
      default: 2,
      minimum: 1
    },
    courseSource: {
      type: 'string',
      title: 'Course input',
      enum: ['cog', 'heading'],
      enumNames: [
        'Course over ground (recommended)',
        'Vessel heading'
      ],
      default: 'cog'
    }
  }
}

module.exports = { schema }