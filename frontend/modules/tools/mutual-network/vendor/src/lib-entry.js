// The graph stack VRCX's Mutual Friends chart uses, exposed for HapsHub's plain scripts.
import Graph from 'graphology';
import Sigma from 'sigma';
import louvain from 'graphology-communities-louvain';
import EdgeCurveProgram from '@sigma/edge-curve';
import { createNodeBorderProgram } from '@sigma/node-border';
window.HHGraphLib = { Graph, Sigma, louvain, EdgeCurveProgram, createNodeBorderProgram };
