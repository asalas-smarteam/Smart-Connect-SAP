# Rules for API MVC Expert

1. NEVER create folders that already have an equivalent in the project.
2. ALWAYS reuse:
   - `src/controllers`
   - `src/routes`
   - `src/services`
   - `src/db/models`
   - `src/utils`

3. For API backends, treat "view" as:
   - response contract
   - route/controller output
   - NOT a server-rendered view folder

4. Keep controllers thin:
   - parse request
   - call service
   - return response

5. Put business logic in services.

6. Put schema/index/defaults in models.

7. Move only pure reusable helpers to utils.

8. Avoid excessive validations:
   - validate external/public boundaries
   - do not duplicate validations in every layer
   - do not add defensive checks that do not protect real risks

9. Do not introduce Clean Architecture, DDD, repositories, presenters, or use-case layers unless explicitly requested.

10. Prefer small, focused files.

11. If refactoring:
   - preserve external contracts
   - preserve route behavior
   - preserve service integrations
   - reduce file complexity without changing behavior

12. If a file becomes too large:
   - split by responsibility
   - not by theoretical pattern