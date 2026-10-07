// ── Comments ──────────────────────────────────────────────────────────────────

// A leading comment becomes a description by one rule (decision 0022): each line's text after its
// marker, one space taken off, its end trimmed, carriage returns read as line feeds; a paragraph's
// lines joined by one space, paragraphs by a blank line. Trailing and detached comments are no
// description. And where a declaration is, by buf's source info, for a finding's line and column.

// dependencies

import type {
  DescEnum,
  DescEnumValue,
  DescFile,
  DescMethod,
  DescService,
} from '@bufbuild/protobuf';

// types

/** A line and a column of a `.proto`, from 1. */
export interface ISourcePosition {
  readonly line: number;
  readonly column: number;
}

// constants

// the fields of descriptor.proto that hold a file's declarations, by their numbers
const FILE_MESSAGE_TYPE = 4;
const FILE_ENUM_TYPE = 5;
const FILE_SERVICE = 6;
const MESSAGE_NESTED_TYPE = 3;
const MESSAGE_ENUM_TYPE = 4;
const SERVICE_METHOD = 2;
const ENUM_VALUE = 2;

// helpers

const lineOf = (line: string): string => {
  return (line.startsWith(' ') ? line.slice(1) : line).trimEnd();
};

// definition

/** A leading comment, as buf's source info holds it, to a description; none when it holds no text. */
export const descriptionOf = (comment: string): string | undefined => {
  const paragraphs: string[] = [];
  let current: string[] = [];

  for (const line of [...comment.replace(/\r\n?/gu, '\n').split('\n').map(lineOf), '']) {
    if (line === '') {
      if (current.length > 0) {
        paragraphs.push(current.join(' '));
      }
      current = [];
    } else {
      current.push(line);
    }
  }

  return paragraphs.length === 0 ? undefined : paragraphs.join('\n\n');
};

/** Where a declaration is in its file's descriptor, as source info paths name it. */
export const pathOf = (desc: DescService | DescMethod | DescEnum | DescEnumValue): number[] => {
  switch (desc.kind) {
    case 'service': {
      return [FILE_SERVICE, desc.file.proto.service.indexOf(desc.proto)];
    }
    case 'rpc': {
      return [...pathOf(desc.parent), SERVICE_METHOD, desc.parent.proto.method.indexOf(desc.proto)];
    }
    case 'enum_value': {
      return [...pathOf(desc.parent), ENUM_VALUE, desc.parent.proto.value.indexOf(desc.proto)];
    }
    case 'enum': {
      const parent = desc.parent;

      if (parent === undefined) {
        return [FILE_ENUM_TYPE, desc.file.proto.enumType.indexOf(desc.proto)];
      }

      const messagePath: number[] = [];

      for (let message = parent; ;) {
        const holder = message.parent;
        messagePath.unshift(
          holder === undefined ? FILE_MESSAGE_TYPE : MESSAGE_NESTED_TYPE,
          (holder === undefined ? message.file.proto.messageType : holder.proto.nestedType).indexOf(
            message.proto
          )
        );

        if (holder === undefined) {
          break;
        }

        message = holder;
      }

      return [...messagePath, MESSAGE_ENUM_TYPE, parent.proto.enumType.indexOf(desc.proto)];
    }
  }
};

/**
 * Where `path` is in `file`, by its source info: the place buf gives the longest prefix of it that
 * has one, its line and column from 1.
 */
export const positionOf = (file: DescFile, path: readonly number[]): ISourcePosition => {
  const locations = file.proto.sourceCodeInfo?.location ?? [];

  for (let length = path.length; length >= 0; length -= 1) {
    const key = path.slice(0, length).join(',');
    const location = locations.find((each) => {
      return each.path.join(',') === key;
    });

    if (location !== undefined) {
      return { line: (location.span[0] ?? 0) + 1, column: (location.span[1] ?? 0) + 1 };
    }
  }

  return { line: 1, column: 1 };
};

/** The description of the declaration at `path` in `file`: its leading comment, by the rule. */
export const leadingOf = (file: DescFile, path: readonly number[]): string | undefined => {
  const key = path.join(',');
  const location = file.proto.sourceCodeInfo?.location.find((each) => {
    return each.path.join(',') === key;
  });

  return descriptionOf(location?.leadingComments ?? '');
};
