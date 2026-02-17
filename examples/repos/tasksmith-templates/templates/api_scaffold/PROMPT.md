# API Endpoint Scaffold

You are scaffolding a new REST API endpoint for project {{project}}.

## Task

{{prompt}}

## Requirements

1. Create the route handler file in the appropriate directory
2. Add request validation (use the project's existing validation library)
3. Add proper error handling with descriptive messages
4. Create comprehensive tests:
   - Happy path for each HTTP method
   - Validation error cases (400)
   - Authentication/authorization (401/403)
   - Not found (404)
   - Edge cases
5. Add the route to the main router/app
6. Update API documentation if a docs file exists

## Output

After implementation, verify by running the test suite. If tests fail,
analyze the errors and fix them before completing.
