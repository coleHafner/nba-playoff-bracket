'use strict'

const rp = require('request-promise');
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const _ = require('lodash');
const pug = require('pug');
const fs = require('fs');
const app = express();
const port = 3000;

const cache = {
	set: (cacheFile, data) => {
		fs.writeFileSync(cacheFile, data);
	},
	get: (cacheFile, callback) => {
		return new Promise((resolve, reject) => {
			fs.readFile(cacheFile, (err, rawData) => {
				if (err) reject(err);
				resolve(JSON.parse(rawData));
			});
		});
	},
	exists: cacheFile => {
		return fs.existsSync(cacheFile);
	},
	getFilePath: url => {
		const filename = `${crypto.createHash('md5').update(url).digest('hex')}.json`;
		return `./cache/${filename}`;

	}
};

app.set('view engine', 'pug');
app.set('views', './views');

const assets = path.join(__dirname, 'assets');
app.use('/assets', express.static(assets));

app.use((req, res, next) => {
	// get data
	const rawData = fs.readFileSync('data.json');
	const jsonData = JSON.parse(rawData);

	// organize data
	const byRound = {
		'one': _.filter(_.cloneDeep(jsonData.series), ['roundNum', '1']),
		'two': _.filter(_.cloneDeep(jsonData.series), ['roundNum', '2']),
		'three': _.filter(_.cloneDeep(jsonData.series), ['roundNum', '3']),
		'finals': _.filter(_.cloneDeep(jsonData.series), ['roundNum', '4']),
	};

	const seeds = _.merge(
		_.groupBy(jsonData.series, 'topRow.teamId'),
		_.groupBy(jsonData.series, 'bottomRow.teamId')
	);
	
	const promises = [];
	
	res.locals = {
		teams: {},
		bracket: byRound, // jsonData.series,
		title: '2018 NBA Playoffs Bracket'
	};

	// grab team data
	_.keys(seeds).forEach(teamId => {
		let promise = getTeamData(teamId)
			.then(team => {
				if (team === false) return;
				res.locals.teams[teamId] = team;
			})
			.catch(err => {
				console.log('err', err);
			});

		promises.push(promise);
	});

	Promise.all(promises)
		.then(() => {
			next();
		})
		.catch(err => {
			console.log('something went wrong.', err);
			res.status(500).send();
		});
});

app.get('/', (req, res) => {
	res.render('index', res.locals);
});

app.listen(port);

function getTeamData(id) {
	const host = `http://stats.nba.com`;
	const path = `/feeds/teams/profile/${id}_TeamProfile.js`;

	// check cache
	const url = host + path;
	const cacheFile = cache.getFilePath(url);

	if (cache.exists(cacheFile)) {
		return cache.get(cacheFile);
	}

	return rp.get(url, {json: true})
		.then(reply => {
			if (!reply.TeamDetails || !reply.TeamDetails[0] || !reply.TeamDetails[0].Details) {
				return false;
			}
			const deets = reply.TeamDetails[0].Details[0];
			cache.set(cacheFile, JSON.stringify(deets));
			return deets;
		});
}