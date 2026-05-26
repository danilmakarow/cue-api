### CLI

# Create a user (also seeds their default "Personal" calendar)
```
pnpm dev-cli create-user --appleUserId dev-danil --email danil@example.com --displayName "Danil M" --timezone Europe/Warsaw
```


# Mint a JWT for them

```
pnpm dev-cli issue-token --appleUserId dev-danil
```
# → { "userId": "…", "appleUserId": "dev-danil", "accessToken": "eyJ…" }

# Or by UUID
```
pnpm dev-cli issue-token --userId <uuid>

pnpm dev-cli help
```