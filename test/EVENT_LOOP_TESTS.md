# Event Loop Tests for promisePoolMap

This document describes the specific test suites that verify `promisePoolMap`'s event loop yielding functionality and non-blocking behavior during database operations.

## Overview

The event loop tests are designed to ensure that the `promisePoolMap` implementation properly yields control to the event loop at specified intervals, preventing the blocking of other asynchronous operations during intensive database processing.

## Test Files

### `promisePoolMap.eventloop.test.js`
**Core event loop yielding functionality tests**

This test suite focuses on the fundamental event loop behavior:
- **Event Loop Yielding**: Verifies that `promisePoolMap` yields control at specified intervals (`yieldEvery` parameter)
- **Non-blocking Behavior**: Ensures other tasks can execute during processing
- **Concurrent Processing**: Verifies yielding works correctly with multiple concurrent operations
- **Error Handling**: Tests that yielding continues even when errors occur during processing
- **Performance**: Ensures yielding doesn't significantly impact overall performance

### `promisePoolMap.integration.test.js`
**Integration tests with actual YASS-ORM methods**

This test suite verifies event loop behavior in real-world usage scenarios:
- **fromSql Integration**: Tests event loop yielding during large result set processing from database queries
- **Database Operations**: Tests yielding during actual database connections and data retrieval
- **Memory Management**: Verifies that yielding helps with memory management during large operations
- **Data Integrity**: Ensures yielding doesn't affect data consistency or correctness
- **Real Database Operations**: Tests with actual database connections (when available, skips gracefully otherwise)

### `run-eventloop-tests.js`
**Dedicated test runner for event loop tests**

A standalone test runner that executes only the event loop-specific tests with appropriate timeouts and the `--exit` flag to ensure proper test completion.

## Running the Event Loop Tests

### Run All Tests (Including Event Loop Tests)
```bash
npm test
```

### Run Only Event Loop Tests
```bash
node test/run-eventloop-tests.js
```

### Run Individual Event Loop Test Files
```bash
# Core event loop tests
npx mocha test/promisePoolMap.eventloop.test.js --exit

# Integration tests (requires database)
npx mocha test/promisePoolMap.integration.test.js --timeout 15000 --exit
```

## Test Categories

### 1. Event Loop Yielding Verification
- Tests verify `yieldEvery` parameter works correctly with different values (1, 3, 5, 8, 10)
- Tests with different concurrency levels (1, 2, 3, 4, 5, 10)
- Measures actual event loop responsiveness using high-resolution timing
- Tests custom yielding configurations

### 2. Non-blocking Behavior Validation
- Ensures other tasks execute during `promisePoolMap` processing
- Tests responsiveness during CPU-intensive operations
- Verifies event loop remains responsive during error conditions
- Tests mixed synchronous/asynchronous workloads

### 3. Integration Pattern Testing
- Simulates `fromSql` result inflation patterns
- Simulates search result processing with ranking calculations
- Tests batch operations similar to real ORM usage patterns
- Verifies data integrity is maintained during yielding

### 4. Performance and Memory Testing
- Large dataset processing (up to 100 items)
- Memory usage monitoring during operations
- Performance impact assessment of yielding
- Concurrent operation handling

## Key Testing Strategies

### Event Loop Responsiveness Measurement
The tests use multiple sophisticated techniques to measure event loop blocking:
- `setImmediate` timing measurements for precision
- Periodic responsiveness checks during processing
- Concurrent task execution verification
- High-resolution timing using `process.hrtime.bigint()`

### CPU-Intensive Work Simulation
Tests include realistic CPU-intensive operations that simulate actual ORM work:
- Database row inflation processing
- JSON parsing and data transformation
- Search ranking calculations
- Data validation and conversion

### Real-world Usage Pattern Simulation
Tests mirror actual YASS-ORM usage patterns:
- Processing large result sets from `fromSql` operations
- Search result inflation with ranking and filtering
- Concurrent database operations
- Error handling during batch processing

## Expected Behavior

### With Event Loop Yielding Enabled
- Other asynchronous tasks should execute during processing
- Event loop should remain responsive (typically < 50ms delays)
- Memory usage should remain stable during large operations
- Processing should complete in reasonable time despite yielding

### Configuration Impact
- **Lower `yieldEvery` values** = more frequent yielding = better responsiveness, slightly slower processing
- **Higher `concurrency`** = more parallel work but still yields appropriately  
- **`yieldEvery: 1`** = yield after every item (maximum responsiveness)
- **`yieldEvery: 10`** = yield every 10 items (default, balanced approach)

## Database Requirements for Integration Tests

Integration tests require:
- Database connection configured in `.yass-orm.js`
- Test database accessible with proper credentials
- Test tables created as per main YASS-ORM test setup
- Tests will skip gracefully if database is unavailable

## Troubleshooting Event Loop Tests

### Tests Report Event Loop Blocking
If event loop tests report blocking issues:
1. Check `yieldEvery` configuration values
2. Verify `yieldToEventLoop()` implementation in `promiseMap.js`
3. Look for synchronous operations that don't yield control

### Integration Tests Skip
If integration tests skip execution:
1. Ensure database is configured and accessible
2. Check `.yass-orm.js` configuration file
3. Verify test tables exist in the database

### Performance Issues
If event loop tests are slow:
1. Consider reducing test data size for faster execution
2. Increase timeout values in test configuration
3. Check for memory leaks in test cleanup
4. Verify cleanup operations are working properly

## Contributing to Event Loop Tests

When adding new event loop tests:
1. Focus on real-world usage patterns from YASS-ORM
2. Include both positive and negative test cases
3. Measure actual responsiveness, not just completion
4. Test with various concurrency and yielding configurations
5. Include proper cleanup code to prevent test interference
6. Use appropriate timeouts and the `--exit` flag for mocha

## Relationship to Other Tests

These event loop tests are part of the broader YASS-ORM test suite but focus specifically on the asynchronous behavior and performance characteristics of the `promisePoolMap` implementation. They complement the existing ORM functionality tests by ensuring that database operations remain non-blocking and responsive.