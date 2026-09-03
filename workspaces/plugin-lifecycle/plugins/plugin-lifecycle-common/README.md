# Plugin Lifecycle common contract

This package contains the shared lifecycle contract used by the frontend,
backend, replay fixture, and agents. It defines the five lifecycle phases,
states, event payload schemas, request/response validation, projection types,
and serialization helpers.

The contract is intentionally independent of GitHub or any other producer.
Adapters append normalized facts through the backend event action, while all
consumers use the same deterministic projection and historical reconstruction
rules.
