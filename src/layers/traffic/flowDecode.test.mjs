import test from 'node:test';
import assert from 'node:assert/strict';

import { readFlowProperties } from './flowDecode.js';
import { isDrivableFlowSegment } from './roadModes.js';

/**
 * The two TomTom endpoints name the same attributes differently: the Maps
 * endpoint says `traffic_level` and `road_type`, the Orbis endpoint says
 * `relative_speed` and `road_category`. One decoder reads both, so the layer
 * downstream sees one vocabulary.
 */

test('a Maps feature keeps its own names', () => {
  const read = readFlowProperties(
    {
      traffic_level: 0.42,
      road_type: 'Major road',
      road_category: 'primary',
      road_subcategory: null,
      left_hand_traffic: false,
    },
    'maps',
  );
  assert.equal(read.trafficLevel, 0.42);
  assert.equal(read.roadType, 'Major road');
  assert.equal(read.roadCategory, 'primary');
  assert.equal(read.coverage, null);
});

test('an Orbis feature reads its speed and names its road like a Maps feature', () => {
  const read = readFlowProperties(
    {
      relative_speed: 0.73,
      road_category: 'secondary',
      road_subcategory: null,
    },
    'orbis',
  );
  assert.equal(read.trafficLevel, 0.73);
  assert.equal(read.roadType, 'Secondary road');
  assert.equal(read.roadCategory, 'secondary');
  // One line per travel direction on a two-way road.
  assert.equal(read.coverage, 'one_side');
  assert.ok(isDrivableFlowSegment({ ...read }));
});

test('an Orbis ramp wears the name of the road it belongs to', () => {
  const read = readFlowProperties(
    { relative_speed: 1, road_category: 'motorway_link' },
    'orbis',
  );
  assert.equal(read.roadType, 'Motorway');
  assert.equal(read.roadCategory, 'motorway');
});

test('an Orbis living street is a minor local road', () => {
  const read = readFlowProperties(
    {
      relative_speed: 1,
      road_category: 'street',
      road_subcategory: 'living_street',
    },
    'orbis',
  );
  assert.equal(read.roadType, 'Minor local road');
});

test('Orbis service roads and tracks are left out', () => {
  for (const category of ['service', 'track']) {
    assert.equal(
      readFlowProperties(
        { relative_speed: 1, road_category: category },
        'orbis',
      ),
      null,
      category,
    );
  }
});

test('a feature without a usable speed is left out, unless it is closed', () => {
  assert.equal(readFlowProperties({ road_category: 'primary' }, 'orbis'), null);
  const closed = readFlowProperties(
    { road_category: 'primary', road_closure: true },
    'orbis',
  );
  assert.equal(closed.trafficLevel, 0);
  assert.equal(closed.closure, true);
});

test('an Orbis speed outside the range is clamped', () => {
  assert.equal(
    readFlowProperties(
      { relative_speed: 1.4, road_category: 'primary' },
      'orbis',
    ).trafficLevel,
    1,
  );
  assert.equal(
    readFlowProperties(
      { relative_speed: -2, road_category: 'primary' },
      'orbis',
    ).trafficLevel,
    0,
  );
});
