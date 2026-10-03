# Decisions

Why Bead is shaped the way it is. One file per decision, each one readable on its own.

A record states a decision that holds: what forced it, what it is, and what it costs. The spec says
what an implementation does, and the code how; a record says why, so that a reason outlives the
person who held it. Code, configuration and other records cite a record by its number, which is
its name for good.

**A decision is changed, not appended to: when one reverses, its Status says so and its successor
is written beside it.** A record that only grows, a date at a time, makes its reader replay every
step to learn where things stand; a record changed in place is readable as it stands. A number is
never given to another decision.

## The decisions

| #                                                                     | Decision                                                                                                                     | Status   |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------- |
| [0001](0001-the-envelope-sits-at-fixed-offsets.md)                    | The envelope sits at fixed big-endian offsets, behind an 8-byte prefix and its layout byte                                   | accepted |
| [0002](0002-a-subscription-goes-at-its-clients-pace.md)               | A subscription goes at its client's pace                                                                                     | accepted |
| [0003](0003-one-word-one-meaning.md)                                  | One word means one thing, and there are no abbreviations                                                                     | accepted |
| [0004](0004-one-behaviour-in-every-language.md)                       | Every language plays one behaviour, held by the conformance files and the interop                                            | accepted |
| [0005](0005-a-toolchain-per-language.md)                              | Each language keeps its own toolchain, and the root holds only what all share                                                | accepted |
| [0006](0006-a-rule-has-its-gate.md)                                   | A rule has its gate, or it is a preference                                                                                   | accepted |
| [0007](0007-csharp-interfaces-blocks-two-parameters-no-warning.md)    | The C# side composes interfaces, writes every body as a block, takes two parameters, and builds without a warning            | accepted |
| [0008](0008-three-version-axes-and-names-qualified-by-their-owner.md) | Versions run on three axes, and names are qualified by their owner                                                           | accepted |
| [0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)       | The repository follows Conventional Commits, git-flow and Keep a Changelog, and what the languages share meets the Tenth Man | accepted |
| [0011](0011-every-side-takes-its-time-from-a-clock-it-is-given.md)    | Every side takes its time from a clock it is given                                                                           | accepted |

## Writing one

The next decision is 0012; 0010 is accepted, and lands with its implementation. Its file is `NNNN-the-decision-in-a-few-words.md`, and its title states
the decision, not its subject.

Nygard's shape, trimmed to what gets read, under a `Status` (accepted, or what replaced it) and a
`Scope`:

- **Context**: the forces, and the options not taken, each described for what it is.
- **Decision**: what holds now, in the present tense.
- **Consequences**: what this costs, and what it makes impossible.

Two things keep these worth reading. **State the cost**: a decision with no consequence is a
preference. And **give the number** where there is one: the sentence that survives a year is the
one with a measurement in it.

A record that changes anything the languages share — the protocol, a name, a behaviour — has the
Tenth Man's objections and their answers kept with it, or with the design the change makes
([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)), and lands with the spec, the
conformance files and every implementation it changes. Add it to the table above in the same change.
