"""The text of a .proto file as make_validations.py and make_transcoding.py write theirs: its head, the
opening of its service, a field's line, a message with its fields and its oneofs, and an enum. Each
generator gives what its own model holds: a field's type and options, a message's and a oneof's."""

# Bead's file option of a file whose procedures admit every call: admission none
ADMISSION_NONE = ['option (bead.file) = {', '  admission: {', '    none: {}', '  }', '};', '']


def head(comments, syntax, package, imports):
    """A file's opening lines: its comments, its syntax or its edition, its package, then its imports."""
    return [*comments, syntax, '', f'package {package};', '', *[f'import "{each}";' for each in imports], '']


def service_head(name, note, options):
    """A service's opening lines, its note and Bead's service option, each of its members on a line."""
    return [f'// {note}', f'service {name} {{', '  option (bead.service) = {', *[f'    {each}' for each in options], '  };',
            '']


def field_text(field, indent, *, type_name, label='', options=()):
    """A field's line: a map's key and value types, or the field's label and its type; its name and its
    number; then its options in brackets, where it has any."""
    if field.label == 'map':
        line = f'map<{field.key}, {type_name}> {field.name} = {field.number}'
    else:
        line = f'{label}{type_name} {field.name} = {field.number}'

    return indent + line + (f' [{", ".join(options)}]' if options else '') + ';'


def message_text(message, declaration, *, options=(), oneof_options=lambda name: ()):
    """A message's text: its note, its options' lines, then its fields in their order, each by
    declaration, the members of a oneof together where its first member stands, after the oneof's own
    options' lines."""
    lines = [f'// {message.note}', f'message {message.name} {{', *options]
    written = set()

    for field in message.fields:
        if field.oneof is None:
            lines.append(declaration(field, '  '))
        elif field.oneof not in written:
            written.add(field.oneof)
            lines.append(f'  oneof {field.oneof} {{')
            lines.extend(oneof_options(field.oneof))
            lines.extend(declaration(member, '    ') for member in message.fields if member.oneof == field.oneof)
            lines.append('  }')

    lines.append('}')
    return '\n'.join(lines)


def enum_text(name, note, values, *, options=()):
    """An enum's text: its note, its options' lines, then its values, each with its number."""
    return '\n'.join([f'// {note}', f'enum {name} {{', *options, *[f'  {value} = {number};' for value, number in values],
                      '}'])
