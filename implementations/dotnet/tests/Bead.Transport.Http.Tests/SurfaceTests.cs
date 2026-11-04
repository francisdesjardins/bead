using System.Reflection;
using System.Runtime.CompilerServices;
using Bead.Protobuf;
using Bead.Transcoding;
using Bead.Transcoding.Http;
using Bead.Transport.Amqp;
using Bead.Transport.Mqtt;
using Bead.Transport.WebSockets;

namespace Bead.Transport.Http.Tests;

/// <summary>
/// The options rule over this side's public surface, by reflection over the eight assemblies an
/// application calls (decisions 0004 and 0007): an options record is a sealed record of
/// <c>init</c> properties, at most two of them <c>required</c>, a setting it cannot be built
/// without; and a parameter that takes one is required exactly when one of its members is. No
/// public member takes or gives a tuple, at any depth of its type: what a caller passes or reads is
/// named. Each public or protected function takes at most two parameters, then at most one options
/// record, last; each public event carries at most two values; and the functions of each assembly,
/// its internal and private ones among them, take no more tuples of three elements or more than
/// its pin. What the rules read the compiler writes into the assembly:
/// <c>RequiredMemberAttribute</c>, the <c>IsExternalInit</c> modifier, a parameter's default and a
/// tuple's own type. The TypeScript side's twins are <c>tools/check-surface.mjs</c> and the rule
/// <c>bead/options-last</c>; the Rust side's, <c>bead-house</c>. The members each side exposes are
/// pinned apart, the C# side's in each project's <c>PublicAPI.Shipped.txt</c> and
/// <c>PublicAPI.Unshipped.txt</c>.
/// </summary>
public sealed class SurfaceTests
{
    // constants

    private const BindingFlags Declared = BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;

    // ! read by name: a package beneath a transport defines its own of each, for the frameworks
    // before them, and only the platform's are the compiler's here
    private const string RequiredMember = "System.Runtime.CompilerServices.RequiredMemberAttribute";

    private const string ExternalInit = "System.Runtime.CompilerServices.IsExternalInit";

    // every function of a type, whatever its access
    private const BindingFlags Everything = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;

    // ! the functions past the parameter rule, each with its reason: the list may only shrink, a
    // function leaving it as it meets the rule
    private static readonly Dictionary<string, string> PastTheParameterRule = new()
    {
        ["Bead.Transcoding.HttpVariable..ctor(FieldPath, Start, End)"] =
            "one concept with the TypeScript side's IVariable, on two rows of its own: its family, the transcoding entry's templates, variables, segments and readings, moves once, its name, members and construction together (0004)",
    };

    // ! the tuples of three elements or more the functions of each assembly take, its internal and
    // private ones among them, by its name, an assembly not named taking none: each pin may only
    // fall, lowered with the count, so a site leaves it by a record of the call and none joins it
    // (decisions 0006 and 0007), as bead-house holds the Rust side's crates
    private static readonly Dictionary<string, int> WideTuples = new()
    {
        ["Bead.Core"] = 35,
        ["Bead.Protobuf"] = 2,
        ["Bead.Transcoding"] = 14,
        ["Bead.Transcoding.Http"] = 9,
        ["Bead.Transport.Amqp"] = 4,
        ["Bead.Transport.Http"] = 6,
    };

    // the eight assemblies an application calls, each by a type of its own
    private static readonly Assembly[] Assemblies =
    [
        typeof(RouterClient).Assembly,
        typeof(IViolationSink).Assembly,
        typeof(JsonForm).Assembly,
        typeof(HttpGateway).Assembly,
        typeof(HttpTransportClient).Assembly,
        typeof(WebSocketTransportClient).Assembly,
        typeof(MqttBrokerAdapter).Assembly,
        typeof(AmqpBrokerAdapter).Assembly,
    ];

    // helpers

    // every public type, of every assembly
    private static IEnumerable<Type> PublicTypes()
    {
        return Assemblies.SelectMany((assembly) =>
        {
            return assembly.GetExportedTypes();
        });
    }

    // whether a type's name, its arity aside, says it is an options record
    private static bool IsOptions(Type type)
    {
        return type.Name.Split('`')[0].EndsWith("Options", StringComparison.Ordinal);
    }

    // every public options record
    private static IEnumerable<Type> OptionsRecords()
    {
        return PublicTypes().Where(IsOptions);
    }

    // the members of an options record the compiler marks required
    private static IEnumerable<string> RequiredOf(Type type)
    {
        var record = type.IsGenericType ? type.GetGenericTypeDefinition() : type;

        return record.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where((property) =>
            {
                return property.GetCustomAttributesData().Any((attribute) =>
                {
                    return attribute.AttributeType.FullName == RequiredMember;
                });
            })
            .Select((property) =>
            {
                return property.Name;
            });
    }

    // what a method of the surface is to the rule: what a programmer writes a call to, never what
    // the compiler makes of a record or a property
    private static bool IsCalled(MethodBase method)
    {
        if (method.IsDefined(typeof(CompilerGeneratedAttribute)))
        {
            return false;
        }

        if (method.IsSpecialName && method is MethodInfo && !method.Name.StartsWith("op_", StringComparison.Ordinal))
        {
            return false;
        }

        // a record's equality, which compares two of it
        if (method.Name is nameof(Equals) or "op_Equality" or "op_Inequality")
        {
            return false;
        }

        // a record's copy constructor, which `with` calls
        return method is not ConstructorInfo || method.GetParameters() is not [{ } only] || only.ParameterType != method.DeclaringType;
    }

    // whether another method of the same name takes what this one takes, the options aside: the
    // optional form a platform rule asks as an overload, as CA1032 asks an exception's
    // constructors, or the one a member required in some instantiations alone asks
    private static bool HasOverloadWithout(MethodBase method, ParameterInfo options)
    {
        var rest = method.GetParameters()
            .Where((parameter) =>
            {
                return parameter.Position != options.Position;
            })
            .Select((parameter) =>
            {
                return parameter.ParameterType;
            })
            .ToArray();

        return method.DeclaringType!.GetMembers(Declared).OfType<MethodBase>().Any((other) =>
        {
            return other.Name == method.Name && other.GetParameters().Select((parameter) =>
            {
                return parameter.ParameterType;
            }).SequenceEqual(rest);
        });
    }

    // what is off the rule in one options parameter, or none
    private static string? Judged(MethodBase method, ParameterInfo parameter)
    {
        var type = Nullable.GetUnderlyingType(parameter.ParameterType) ?? parameter.ParameterType;
        var required = RequiredOf(type).Any();
        var name = $"{method.DeclaringType!.FullName}.{method.Name}({parameter.Name}: {type.Name})";

        if (required && parameter.HasDefaultValue)
        {
            return $"{name}: optional though a member is required";
        }

        // * options Bead hands a callback are always given
        if (required || parameter.HasDefaultValue || typeof(Delegate).IsAssignableFrom(method.DeclaringType) || HasOverloadWithout(method, parameter))
        {
            return null;
        }

        return $"{name}: required though every member is optional";
    }

    // whether a type holds a tuple at any depth: itself, what it is an array, a pointer or a
    // reference of, or one of a generic's arguments, so Task<(…)> and IReadOnlyList<(…)> hold one;
    // a KeyValuePair<,> is a map's entry, no tuple
    private static bool HoldsTuple(Type type)
    {
        if (type.HasElementType)
        {
            return HoldsTuple(type.GetElementType()!);
        }

        if (!type.IsGenericType)
        {
            return false;
        }

        var definition = type.GetGenericTypeDefinition().FullName ?? "";

        // * every arity of both, their eighth element's rest among them
        if (definition.StartsWith("System.ValueTuple`", StringComparison.Ordinal) || definition.StartsWith("System.Tuple`", StringComparison.Ordinal))
        {
            return true;
        }

        return type.GetGenericArguments().Any(HoldsTuple);
    }

    // what of one public member takes or gives a tuple: a method's, a constructor's or a delegate's
    // Invoke's parameters and return, a property's, a field's, a constant's or an event's type
    private static IEnumerable<string> TuplesOf(MemberInfo member)
    {
        var name = $"{member.DeclaringType!.FullName}.{member.Name}";

        switch (member)
        {
            case MethodBase method when IsCalled(method):
                foreach (var parameter in method.GetParameters().Where((parameter) =>
                {
                    return HoldsTuple(parameter.ParameterType);
                }))
                {
                    yield return $"{name}({parameter.Name})";
                }

                if (method is MethodInfo { ReturnType: var returned } && HoldsTuple(returned))
                {
                    yield return $"{name}: its return";
                }

                break;
            case PropertyInfo property when HoldsTuple(property.PropertyType):
                yield return name;
                break;
            case FieldInfo field when HoldsTuple(field.FieldType):
                yield return name;
                break;
            case EventInfo handled when HoldsTuple(handled.EventHandlerType!):
                yield return name;
                break;
            default:
                break;
        }
    }

    // whether a caller outside its assembly reaches a function: public, or protected
    private static bool IsReached(MethodBase method)
    {
        return method.IsPublic || method.IsFamily || method.IsFamilyOrAssembly;
    }

    // the functions of a public type the parameter rule reads: each method and constructor a
    // programmer calls, a positional record's primary constructor among them, never what the
    // compiler writes of a record; of a delegate, its Invoke alone, which says its call
    private static IEnumerable<MethodBase> FunctionsOf(Type type)
    {
        if (typeof(Delegate).IsAssignableFrom(type))
        {
            return type.GetMethod("Invoke") is { } invoke ? [invoke] : [];
        }

        return type.GetMembers(Everything)
            .OfType<MethodBase>()
            .Where((method) =>
            {
                return IsReached(method) && IsCalled(method) && method.Name != "Deconstruct";
            });
    }

    // what is off the parameter rule in one function, or none: at most two parameters that are no
    // options record, then at most one options record, and nothing after it
    private static string? ParametersJudged(MethodBase method)
    {
        var parameters = method.GetParameters();
        var names = parameters.Select((parameter) =>
        {
            return parameter.Name;
        });
        var name = $"{method.DeclaringType!.FullName}.{method.Name}({string.Join(", ", names)})";
        var options = parameters
            .Where((parameter) =>
            {
                return IsOptions(Nullable.GetUnderlyingType(parameter.ParameterType) ?? parameter.ParameterType);
            })
            .ToList();
        var things = parameters.Length - options.Count;

        if (options.Count > 1)
        {
            return $"{name}: {options.Count} options records";
        }

        if (options is [{ } only] && only.Position != parameters.Length - 1)
        {
            return $"{name}: something after its options";
        }

        return things > 2 ? $"{name}: {things} parameters besides its options" : null;
    }

    // the elements of the tuple a parameter's own type is, by reference or not; none for one an
    // array, a nullable or a generic's argument holds, which is no tuple taken
    private static int ElementsOf(Type type)
    {
        var own = type.IsByRef ? type.GetElementType()! : type;

        if (!own.IsGenericType)
        {
            return 0;
        }

        var definition = own.GetGenericTypeDefinition().FullName ?? "";
        var isTuple = definition.StartsWith("System.ValueTuple`", StringComparison.Ordinal) || definition.StartsWith("System.Tuple`", StringComparison.Ordinal);

        return isTuple ? own.GetGenericArguments().Length : 0;
    }

    // the methods a type implements an interface's with: counted where the interface declares them
    private static HashSet<MethodInfo> ImplementingOf(Type type)
    {
        var implementing = new HashSet<MethodInfo>();

        if (type.IsInterface)
        {
            return implementing;
        }

        foreach (var contract in type.GetInterfaces())
        {
            implementing.UnionWith(type.GetInterfaceMap(contract).TargetMethods.Where((method) =>
            {
                return method.DeclaringType == type;
            }));
        }

        return implementing;
    }

    // whether the ratchet reads a method: one a programmer wrote, a local function among them,
    // never a lambda, nor what the compiler writes of a record, a state machine or a property; an
    // override or an interface's member is counted where it is declared, never where implemented
    private static bool IsWritten(MethodBase method, HashSet<MethodInfo> implementing)
    {
        // * a local function's name, as the compiler writes it: <Outer>g__Name|…
        var isLocal = method.Name.Contains(">g__", StringComparison.Ordinal);

        if (method.IsDefined(typeof(CompilerGeneratedAttribute)) && !isLocal)
        {
            return false;
        }

        if (method is MethodInfo info)
        {
            var isAccessor = info.IsSpecialName && !info.Name.StartsWith("op_", StringComparison.Ordinal);
            var isImplementing = info.GetBaseDefinition() != info || implementing.Contains(info);
            var isDelegateMachinery = typeof(Delegate).IsAssignableFrom(info.DeclaringType) && info.Name != "Invoke";

            if (isAccessor || isImplementing || isDelegateMachinery)
            {
                return false;
            }
        }

        return isLocal || !method.DeclaringType!.IsDefined(typeof(CompilerGeneratedAttribute));
    }

    // each parameter of an assembly's functions that takes a tuple of three elements or more
    private static IEnumerable<string> WideTuplesOf(Assembly assembly)
    {
        return assembly.GetTypes().SelectMany((type) =>
        {
            var implementing = ImplementingOf(type);

            return type.GetMembers(Everything)
                .OfType<MethodBase>()
                .Where((method) =>
                {
                    return IsWritten(method, implementing);
                })
                .SelectMany((method) =>
                {
                    return method.GetParameters()
                        .Where((parameter) =>
                        {
                            return ElementsOf(parameter.ParameterType) >= 3;
                        })
                        .Select((parameter) =>
                        {
                            return $"{type.FullName}.{method.Name}({parameter.Name})";
                        });
                });
        });
    }

    // tests

    [Fact]
    public void Takes_and_gives_no_tuple_on_the_public_surface()
    {
        var members = PublicTypes()
            .SelectMany((type) =>
            {
                return type.GetMembers(Declared);
            })
            .ToList();
        var off = members.SelectMany(TuplesOf);

        Assert.NotEmpty(members);
        Assert.Empty(off);
    }

    [Fact]
    public void Every_public_options_record_is_a_sealed_record_of_init_properties()
    {
        var records = OptionsRecords().ToList();
        var off = records
            .Where((type) =>
            {
                var isRecord = type.GetMethod("<Clone>$") is not null;
                var isInit = type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
                    .Where((property) =>
                    {
                        return property.SetMethod is { IsPublic: true };
                    })
                    .All((property) =>
                    {
                        return property.SetMethod!.ReturnParameter.GetRequiredCustomModifiers().Any((modifier) =>
                        {
                            return modifier.FullName == ExternalInit;
                        });
                    });

                return !(type.IsSealed && isRecord && isInit);
            })
            .Select((type) =>
            {
                return type.FullName;
            });

        Assert.NotEmpty(records);
        Assert.Empty(off);
    }

    [Fact]
    public void Takes_an_options_record_required_exactly_when_one_of_its_members_is_required()
    {
        var judged = PublicTypes()
            .SelectMany((type) =>
            {
                return type.GetMembers(Declared).OfType<MethodBase>();
            })
            .Where(IsCalled)
            .SelectMany((method) =>
            {
                return method.GetParameters()
                    .Where((parameter) =>
                    {
                        return IsOptions(Nullable.GetUnderlyingType(parameter.ParameterType) ?? parameter.ParameterType);
                    })
                    .Select((parameter) =>
                    {
                        return Judged(method, parameter);
                    });
            })
            .ToList();

        Assert.NotEmpty(judged);
        Assert.Empty(judged.OfType<string>());
    }

    [Fact]
    public void An_options_record_requires_two_members_at_most()
    {
        var records = OptionsRecords().ToList();
        var off = records
            .Where((type) =>
            {
                return RequiredOf(type).Count() > 2;
            })
            .Select((type) =>
            {
                return $"{type.FullName}: {string.Join(", ", RequiredOf(type))}";
            });

        Assert.Contains(records, (type) =>
        {
            return RequiredOf(type).Any();
        });
        Assert.Empty(off);
    }

    [Fact]
    public void Takes_two_parameters_at_most_then_one_options_record_last()
    {
        var functions = PublicTypes().SelectMany(FunctionsOf).ToList();
        var judged = functions.Select(ParametersJudged).OfType<string>().ToList();
        var off = judged.Where((verdict) =>
        {
            return !PastTheParameterRule.Keys.Any((listed) =>
            {
                return verdict.StartsWith($"{listed}:", StringComparison.Ordinal);
            });
        });

        // * a function listed that meets the rule leaves the list
        var met = PastTheParameterRule.Keys.Where((listed) =>
        {
            return !judged.Any((verdict) =>
            {
                return verdict.StartsWith($"{listed}:", StringComparison.Ordinal);
            });
        });

        Assert.NotEmpty(functions);
        Assert.Empty(off);
        Assert.Empty(met);
    }

    [Fact]
    public void Holds_every_public_event_to_two_values_at_most()
    {
        var events = PublicTypes()
            .SelectMany((type) =>
            {
                return type.GetEvents(Declared);
            })
            .ToList();
        var off = events
            .Where((told) =>
            {
                return told.EventHandlerType!.GetMethod("Invoke")!.GetParameters().Length > 2;
            })
            .Select((told) =>
            {
                return $"{told.DeclaringType!.FullName}.{told.Name}";
            });

        Assert.NotEmpty(events);
        Assert.Empty(off);
    }

    [Fact]
    public void Takes_no_more_tuples_of_three_elements_or_more_than_each_member_s_pin()
    {
        var moved = Assemblies
            .Select((assembly) =>
            {
                var name = assembly.GetName().Name!;
                var found = WideTuplesOf(assembly).Order(StringComparer.Ordinal).ToList();
                var pin = WideTuples.GetValueOrDefault(name);
                var said = found.Count > pin ? "joined its count, a record of the call in its place" : "fell below its pin, the pin to lower with it";

                return found.Count == pin ? null : $"{name}: {found.Count} counted, its pin {pin}: {said}{Environment.NewLine}{string.Join(Environment.NewLine, found)}";
            })
            .OfType<string>()
            .ToList();

        // * each site named, so the one that joined is found, or the pin lowered with what left
        Assert.True(moved.Count == 0, $"the tuples of three elements or more leave their pins:{Environment.NewLine}{string.Join(Environment.NewLine, moved)}");
    }
}
