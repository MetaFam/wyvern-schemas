import * as ethABI from 'ethereumjs-abi';
import * as Web3 from 'web3';

import {
  AnnotatedFunctionABI,
  FunctionInputKind,
  Schema,
} from './types';

const failWith = (msg: string): any => {
  throw new Error(msg);
};

export interface LimitedCallSpec {
  target: string;
  calldata: string;
}

export const encodeCall = (abi: Web3.MethodAbi, parameters: any[]): string => {
  const inputTypes = abi.inputs.map(i => i.type);
  return '0x' + Buffer.concat([
    ethABI.methodID(abi.name, inputTypes),
    ethABI.rawEncode(inputTypes, parameters),
  ]).toString('hex');
};

const generateDefaultValue = (type: string): any => {
  switch (type) {
    case 'address':
      /* Null address is sometimes checked in transfer calls. */
      return '0x1111111111111111111111111111111111111111';
    case 'bytes32':
      return '0x0000000000000000000000000000000000000000000000000000000000000000';
    case 'bool':
      return false;
    case 'int':
    case 'uint':
    case 'uint8':
    case 'uint16':
    case 'uint32':
    case 'uint64':
    case 'uint256':
      return 0;
    default:
      failWith('Default value not yet implemented for type: ' + type);
  }
};

export interface CallSpec {
  target: string;
  calldata: string;
  replacementPattern: string;
}

export type SellEncoder<T> = (schema: Schema<T>, asset: T, address: string) => CallSpec;

export const encodeSell: SellEncoder<any> = (schema, asset, address) => {
  const transfer = getTransferFunction(schema)(asset);
  return {
    target: transfer.target,
    calldata: encodeDefaultCall(transfer, address),
    replacementPattern: encodeReplacementPattern(transfer),
  };
};

export type BuyEncoder<T> = (schema: Schema<T>, asset: T, address: string) => CallSpec;

export const encodeBuy: BuyEncoder<any> = (schema, asset, address) => {
  const transfer = getTransferFunction(schema)(asset);
  const replaceables = transfer.inputs.filter((i: any) => i.kind === FunctionInputKind.Replaceable);
  const ownerInputs = transfer.inputs.filter((i: any) => i.kind === FunctionInputKind.Owner);

  // Validate
  if (replaceables.length !== 1) {
    failWith('Only 1 input can match transfer destination, but instead ' + replaceables.length + ' did');
  }

  // Compute calldata
  const parameters = transfer.inputs.map((input: any) => {
    switch (input.kind) {
      case FunctionInputKind.Replaceable:
        return address;
      case FunctionInputKind.Owner:
        return generateDefaultValue(input.type);
      default:
        return input.value.toString();
    }
  });
  const calldata = encodeCall(transfer, parameters);

  // Compute replacement pattern
  let replacementPattern = '0x';
  if (ownerInputs.length > 0) {
    replacementPattern = encodeReplacementPattern(transfer, FunctionInputKind.Owner);
  }

  return {
    target: transfer.target,
    calldata,
    replacementPattern,
  };
};

export type DefaultCallEncoder = (abi: AnnotatedFunctionABI, address: string) => string;

export const encodeDefaultCall: DefaultCallEncoder = (abi, address) => {
  const parameters = abi.inputs.map(input => {
    switch (input.kind) {
      case FunctionInputKind.Asset:
        return input.value;
      case FunctionInputKind.Replaceable:
        return generateDefaultValue(input.type);
      case FunctionInputKind.Owner:
        return address;
    }
  });
  return encodeCall(abi, parameters);
};

export type ReplacementEncoder = (abi: AnnotatedFunctionABI, kind?: FunctionInputKind) => string;

export const encodeReplacementPattern: ReplacementEncoder = (abi, replaceKind = FunctionInputKind.Replaceable) => {
  const allowReplaceBit = '1';
  const doNotAllowReplaceBit = '0';
  /* Four bytes for method ID. */
  const maskArr: string[] = [doNotAllowReplaceBit, doNotAllowReplaceBit,
    doNotAllowReplaceBit, doNotAllowReplaceBit];
  /* This DOES NOT currently support dynamic-length data (arrays). */
  abi.inputs.map(i => {
    const type = ethABI.elementaryName(i.type);
    const encoded = ethABI.encodeSingle(type, generateDefaultValue(i.type));
    if (i.kind === replaceKind) {
      maskArr.push((allowReplaceBit as any).repeat(encoded.length));
    } else {
      maskArr.push((doNotAllowReplaceBit as any).repeat(encoded.length));
    }
  });
  let mask = maskArr.reduce((x, y) => x + y, '');
  const ret = [];
  /* Encode into bytes. */
  while (true) {
    let byteChars = (mask.substr(0, 8) as any);
    if (byteChars.length === 0) {
      break;
    }
    byteChars = byteChars.padEnd(8, '0');
    let byte = 0;
    let mul = 2 ** 7;
    for (let i = 0; i < 8; i++) {
      byte += byteChars[i] === allowReplaceBit ? mul : 0;
      mul = mul / 2;
    }
    const buf = Buffer.alloc(1);
    buf.writeUInt8(byte, 0);
    ret.push(buf);
    mask = mask.slice(8);
  }
  return '0x' + Buffer.concat(ret).toString('hex');
};

function getTransferFunction(schema: any) {
  return schema.functions.transferFrom
    || schema.functions.transfer;
}
