function simplifyType(type: object): object {
    const processed = simplifyTypeHelper(type);

    // Normalize the property order

    const result: any = {
        id: processed.id,
        kind: processed.kind,
        name: processed.name,
        aliasTypeArguments: processed.aliasTypeArguments,
        instantiatedType: processed.instantiatedType,
        typeArguments: processed.typeArguments,
    };

    for (const prop in processed) {
        if (!result[prop] && prop !== "location" && prop !== "display") {
            result[prop] = processed[prop];
        }
    }

    result["location"] = processed.location;
    result["display"] = processed.display;

    return result;
}

function simplifyTypeHelper(type: any): any {
    type.name = type.symbolName;
    type.symbolName = undefined;

    const isDestructuring = !!type.destructuringPattern;
    const node = type.destructuringPattern ?? type.referenceLocation ?? type.firstDeclaration;
    type.destructuringPattern = undefined;
    type.referenceLocation = undefined;
    type.firstDeclaration = undefined;
    type.location = node && {
        path: node.path,
        line: node.start?.line,
        char: node.start?.character,
    };

    const flags = type.flags;
    type.flags = undefined;

    const display = type.display;
    type.display = undefined;

    type.recursionId = undefined;

    if (type.intrinsicName) {
        return {
            kind: "Intrinsic",
            ...type,
            name: type.intrinsicName,
            intrinsicName: undefined,
        };
    }

    if (type.unionTypes) {
        return {
            kind: makeAliasedKindIfNamed(type, "Union"),
            count: type.unionTypes.length,
            types: type.unionTypes,
            ...type,
            unionTypes: undefined,
        };
    }

    if (type.intersectionTypes) {
        return {
            kind: makeAliasedKindIfNamed(type, "Intersection"),
            count: type.intersectionTypes.length,
            types: type.intersectionTypes,
            ...type,
            intersectionTypes: undefined,
        };
    }

    if (type.indexedAccessObjectType) {
        return {
            kind: makeAliasedKindIfNamed(type, "IndexedAccess"),
            ...type,
        };
    }

    if (type.keyofType) {
        return {
            kind: makeAliasedKindIfNamed(type, "IndexType"),
            ...type,
        };
    }

    if (type.isTuple) {
        return {
            kind: makeAliasedKindIfNamed(type, "Tuple"),
            ...type,
            isTuple: undefined,
        };
    }

    if (type.conditionalCheckType) {
        return {
            kind: makeAliasedKindIfNamed(type, "ConditionalType"),
            ...type,
            conditionalTrueType: type.conditionalTrueType < 0 ? undefined : type.conditionalTrueType,
            conditionalFalseType: type.conditionalFalseType < 0 ? undefined : type.conditionalFalseType,
        };
    }

    if (type.substitutionBaseType) {
        return {
            kind: makeAliasedKindIfNamed(type, "SubstitutionType"),
            originalType: type.substitutionBaseType,
            ...type,
            substitutionBaseType: undefined,
        };
    }

    if (type.reverseMappedSourceType) {
        return {
            kind: makeAliasedKindIfNamed(type, "ReverseMappedType"),
            sourceType: type.reverseMappedSourceType,
            mappedType: type.reverseMappedMappedType,
            constraintType: type.reverseMappedConstraintType,
            ...type,
            reverseMappedSourceType: undefined,
            reverseMappedMappedType: undefined,
            reverseMappedConstraintType: undefined,
        };
    }

    if (type.aliasTypeArguments) {
        return {
            kind: "GenericTypeAlias",
            ...type,
            instantiatedType: undefined,
            aliasedType: type.instantiatedType,
            aliasedTypeTypeArguments: type.typeArguments,
        };
    }

    if (type.instantiatedType && type.typeArguments?.length) {
        const instantiatedIsSelf = type.instantiatedType === type.id;
        return {
            kind: instantiatedIsSelf ? "GenericType" : "GenericInstantiation",
            ...type,
            instantiatedType: instantiatedIsSelf ? undefined : type.instantiatedType,
        };
    }

    if (isDestructuring) {
        return {
            kind: "Destructuring",
            ...type,
        };
    }

    if (flags.includes("StringLiteral")) {
        return {
            kind: "StringLiteral",
            value: display,
            ...type,
        };
    }

    if (flags.includes("NumberLiteral")) {
        return {
            kind: "NumberLiteral",
            value: display,
            ...type,
        };
    }

    if (flags.includes("BigIntLiteral")) {
        return {
            kind: "BigIntLiteral",
            value: display,
            ...type,
        };
    }

    if (flags.includes("TypeParameter")) {
        return {
            kind: "TypeParameter",
            ...type,
        };
    }

    if (flags.includes("UniqueESSymbol")) {
        return {
            kind: "Unique",
            ...type,
        };
    }

    if (type.name?.startsWith("__@")) {
        const match = /^__@([^@]+)@\d+$/.exec(type.name);
        return {
            kind: "KnownSymbol",
            ...type,
            name: match ? match[1] : type.name,
        };
    }

    if (type.name === "__function" ||
        type.name === "__type" ||
        type.name === "__class" ||
        type.name === "__object") {
        return makeAnonymous(type);
    }

    if (type.name === "__jsxAttributes") {
        return makeAnonymous(type, "JsxAttributesType");
    }

    // This is less specific than the name checks
    if (flags.includes("Object") && type.name) {
        return {
            kind: "Object",
            ...type,
        };
    }

    // This goes at the end because it's a guess and depends on other interpretations having been checked previously
    if (display && display.startsWith("(props:") && display.endsWith("=> Element")) {
        return {
            kind: "JsxElementSignature",
            ...type,
            display
        };
    }

    return {
        kind: "Other",
        ...type,
        display
    };

    function makeAnonymous(type: any, kind?: string): any {
        return {
            kind: kind ?? "Anonymous" + firstToUpper(type.name.replace(/^__/, "")),
            ...type,
            display: type.location ? undefined : display,
            name: undefined,
        };
    }

    function makeAliasedKindIfNamed(type: { name?: string }, kind: string) {
        return type.name ? "Aliased" + kind : kind;
    }
}

function firstToUpper(name: string) {
    return name[0].toUpperCase() + name.substring(1);
}

export = simplifyType;